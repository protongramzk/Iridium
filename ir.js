/**
 * IRManager - Single Authoritative State Manager untuk IR
 * Dengan dukungan IF/ELIF/ELSE dan LOOP
 */

class IRManager {
  #ir = null;
  #txStack = [];
  #history = [];
  #historyIdx = -1;
  #idCounters = {};

  constructor() {
    this.#ir = {
      meta: { version: '2.0.0', created: Date.now(), modified: Date.now() },
      variables: { static: [], reactive: [], fetch: [] },
      elements: { rootId: null, nodes: {} },
      events: { click: [], change: [], input: [], submit: [], focus: [], blur: [] },
      bindings: [],
      conditionalGroups: {}, // { groupId: { if: elId, elif: [elId], else: elId } }
      effects: [],
      dirtyFlags: { 
        elements: new Set(), 
        variables: new Set(), 
        events: new Set(), 
        bindings: new Set(), 
        conditionals: new Set(),
        loops: new Set(),
        structure: false 
      }
    };
  }

  // ==================== ID ====================
  
  id(type) {
    this.#idCounters[type] = (this.#idCounters[type] || 0) + 1;
    return `${type}_${this.#idCounters[type]}_${Date.now()}`;
  }

  // ==================== TRANSACTION ====================
  
  tx(label, fn) {
    this.beginTx(label);
    try {
      const result = fn();
      this.commit();
      return result;
    } catch (e) {
      this.rollback();
      throw e;
    }
  }

  beginTx(label = 'tx') {
    this.#txStack.push({ label, snapshot: this.#clone(this.#ir), startTime: Date.now() });
  }

  commit() {
    if (!this.#txStack.length) throw new Error('No active transaction');
    
    const tx = this.#txStack.pop();
    
    if (this.#txStack.length === 0) {
      this.#history = this.#history.slice(0, this.#historyIdx + 1);
      this.#history.push({ label: tx.label, snapshot: this.#clone(this.#ir), timestamp: Date.now() });
      this.#historyIdx++;
      
      if (this.#history.length > 50) {
        this.#history.shift();
        this.#historyIdx--;
      }
      
      this.#ir.meta.modified = Date.now();
    }
  }

  rollback() {
    if (!this.#txStack.length) throw new Error('No active transaction');
    const tx = this.#txStack.pop();
    this.#ir = tx.snapshot;
  }

  undo() {
    if (this.#txStack.length) throw new Error('Cannot undo during transaction');
    if (this.#historyIdx < 0 || !this.#history.length) return false;
    
    const snap = this.#history[this.#historyIdx];
    if (!snap?.snapshot) return false;
    
    this.#ir = this.#clone(snap.snapshot);
    this.#historyIdx--;
    return true;
  }

  redo() {
    if (this.#txStack.length) throw new Error('Cannot redo during transaction');
    if (this.#historyIdx >= this.#history.length - 1) return false;
    
    this.#historyIdx++;
    const snap = this.#history[this.#historyIdx];
    if (!snap?.snapshot) {
      this.#historyIdx--;
      return false;
    }
    
    this.#ir = this.#clone(snap.snapshot);
    return true;
  }

  canUndo() { return this.#historyIdx >= 0 && this.#history.length > 0 && !this.#txStack.length; }
  canRedo() { return this.#historyIdx < this.#history.length - 1 && !this.#txStack.length; }

  // ==================== ELEMENT ====================
  
  create({ kind, tag = 'div', parent = null, text = null, styles = {}, classes = [], attrs = {} }) {
    this.#ensureTx('create');
    
    const id = this.id('el');
    this.#ir.elements.nodes[id] = {
      id, kind, tag, children: [], parent: null,
      text, textBinding: null, styles, classes: new Set(classes), attrs,
      control: null,  // IF/ELIF/ELSE control
      loop: null      // EACH loop
    };
    
    if (parent) this.append(parent, id);
    else if (!this.#ir.elements.rootId) this.#ir.elements.rootId = id;
    
    this.#dirty('elements', id);
    this.#dirty('structure', true);
    return id;
  }

  delete(id) {
    this.#ensureTx('delete');
    
    const el = this.#ir.elements.nodes[id];
    if (!el) throw new Error(`Element ${id} not found`);
    
    // Delete children recursively
    [...el.children].forEach(child => this.delete(child));
    
    // Remove from parent
    if (el.parent) {
      const parent = this.#ir.elements.nodes[el.parent];
      parent.children = parent.children.filter(c => c !== id);
    }
    
    // Remove from conditional group if exists
    if (el.control) {
      this.#removeFromConditionalGroup(id, el.control.group);
    }
    
    // Remove events
    Object.keys(this.#ir.events).forEach(type => {
      this.#ir.events[type] = this.#ir.events[type].filter(e => e.target !== id);
    });
    
    // Remove bindings
    this.#ir.bindings = this.#ir.bindings.filter(b => b.elementId !== id);
    
    delete this.#ir.elements.nodes[id];
    
    if (this.#ir.elements.rootId === id) this.#ir.elements.rootId = null;
    
    this.#dirty('elements', id);
    this.#dirty('structure', true);
  }

  append(parentId, childId) {
    this.#ensureTx('append');
    
    const parent = this.#ir.elements.nodes[parentId];
    const child = this.#ir.elements.nodes[childId];
    if (!parent || !child) throw new Error('Parent or child not found');
    
    if (child.parent) {
      const oldParent = this.#ir.elements.nodes[child.parent];
      oldParent.children = oldParent.children.filter(c => c !== childId);
    }
    
    parent.children.push(childId);
    child.parent = parentId;
    
    this.#dirty('elements', parentId);
    this.#dirty('elements', childId);
    this.#dirty('structure', true);
  }

  insert(parentId, childId, index) {
    this.#ensureTx('insert');
    
    const parent = this.#ir.elements.nodes[parentId];
    const child = this.#ir.elements.nodes[childId];
    if (!parent || !child) throw new Error('Parent or child not found');
    
    if (child.parent) {
      const oldParent = this.#ir.elements.nodes[child.parent];
      oldParent.children = oldParent.children.filter(c => c !== childId);
    }
    
    parent.children.splice(index, 0, childId);
    child.parent = parentId;
    
    this.#dirty('elements', parentId);
    this.#dirty('elements', childId);
    this.#dirty('structure', true);
  }

  setText(id, value) {
    this.#ensureTx('setText');
    const el = this.#ir.elements.nodes[id];
    if (!el) throw new Error(`Element ${id} not found`);
    if (el.textBinding) throw new Error('Cannot set text on bound element');
    
    el.text = value;
    this.#dirty('elements', id);
  }

  bindText(id, varName) {
    this.#ensureTx('bindText');
    const el = this.#ir.elements.nodes[id];
    if (!el) throw new Error(`Element ${id} not found`);
    if (el.text !== null) throw new Error('Cannot bind element with static text');
    
    el.textBinding = varName;
    this.#ir.bindings.push({ id: this.id('bind'), elementId: id, variable: varName, kind: 'text', key: null });
    
    this.#dirty('elements', id);
    this.#dirty('bindings', id);
  }

  unbindText(id) {
    this.#ensureTx('unbindText');
    const el = this.#ir.elements.nodes[id];
    if (!el) throw new Error(`Element ${id} not found`);
    
    el.textBinding = null;
    this.#ir.bindings = this.#ir.bindings.filter(b => !(b.elementId === id && b.kind === 'text'));
    
    this.#dirty('elements', id);
    this.#dirty('bindings', id);
  }

  style(id, prop, value) {
    this.#ensureTx('style');
    const el = this.#ir.elements.nodes[id];
    if (!el) throw new Error(`Element ${id} not found`);
    
    if (value === null || value === undefined) delete el.styles[prop];
    else el.styles[prop] = value;
    
    this.#dirty('elements', id);
  }

  class(id, className, add = true) {
    this.#ensureTx('class');
    const el = this.#ir.elements.nodes[id];
    if (!el) throw new Error(`Element ${id} not found`);
    
    if (add) el.classes.add(className);
    else el.classes.delete(className);
    
    this.#dirty('elements', id);
  }

  attr(id, name, value) {
    this.#ensureTx('attr');
    const el = this.#ir.elements.nodes[id];
    if (!el) throw new Error(`Element ${id} not found`);
    
    if (value === null || value === undefined) delete el.attrs[name];
    else el.attrs[name] = value;
    
    this.#dirty('elements', id);
  }

  // ==================== CONDITIONAL (IF/ELIF/ELSE) ====================
  
  createIfGroup(parentId, { expr, element }) {
    this.#ensureTx('createIfGroup');
    
    const groupId = this.id('cond');
    const elId = this.create({ ...element, parent: parentId });
    
    const el = this.#ir.elements.nodes[elId];
    el.control = {
      type: 'if',
      expr,
      group: groupId
    };
    
    this.#ir.conditionalGroups[groupId] = {
      if: elId,
      elif: [],
      else: null
    };
    
    this.#dirty('conditionals', groupId);
    return { groupId, elementId: elId };
  }

  addElif(groupId, { expr, element }) {
    this.#ensureTx('addElif');
    
    const group = this.#ir.conditionalGroups[groupId];
    if (!group) throw new Error(`Conditional group ${groupId} not found`);
    if (!group.if) throw new Error('Group must have IF before ELIF');
    
    // Get parent from IF element
    const ifEl = this.#ir.elements.nodes[group.if];
    const parentId = ifEl.parent;
    
    const elId = this.create({ ...element, parent: parentId });
    const el = this.#ir.elements.nodes[elId];
    el.control = {
      type: 'elif',
      expr,
      group: groupId
    };
    
    group.elif.push(elId);
    this.#dirty('conditionals', groupId);
    return elId;
  }

  addElse(groupId, { element }) {
    this.#ensureTx('addElse');
    
    const group = this.#ir.conditionalGroups[groupId];
    if (!group) throw new Error(`Conditional group ${groupId} not found`);
    if (!group.if) throw new Error('Group must have IF before ELSE');
    if (group.else) throw new Error('Group already has ELSE');
    
    // Get parent from IF element
    const ifEl = this.#ir.elements.nodes[group.if];
    const parentId = ifEl.parent;
    
    const elId = this.create({ ...element, parent: parentId });
    const el = this.#ir.elements.nodes[elId];
    el.control = {
      type: 'else',
      group: groupId
    };
    
    group.else = elId;
    this.#dirty('conditionals', groupId);
    return elId;
  }

  updateCondition(elementId, expr) {
    this.#ensureTx('updateCondition');
    
    const el = this.#ir.elements.nodes[elementId];
    if (!el || !el.control) throw new Error('Element has no control');
    if (el.control.type === 'else') throw new Error('ELSE cannot have expression');
    
    el.control.expr = expr;
    this.#dirty('conditionals', el.control.group);
  }

  removeConditional(elementId) {
    this.#ensureTx('removeConditional');
    
    const el = this.#ir.elements.nodes[elementId];
    if (!el || !el.control) throw new Error('Element has no control');
    
    const groupId = el.control.group;
    this.#removeFromConditionalGroup(elementId, groupId);
    this.delete(elementId);
  }

  #removeFromConditionalGroup(elementId, groupId) {
    const group = this.#ir.conditionalGroups[groupId];
    if (!group) return;
    
    if (group.if === elementId) {
      // IF deleted, whole group becomes invalid
      delete this.#ir.conditionalGroups[groupId];
      this.#dirty('conditionals', groupId);
    } else if (group.elif.includes(elementId)) {
      group.elif = group.elif.filter(id => id !== elementId);
      this.#dirty('conditionals', groupId);
    } else if (group.else === elementId) {
      group.else = null;
      this.#dirty('conditionals', groupId);
    }
  }

  getConditionalGroup(groupId) {
    const group = this.#ir.conditionalGroups[groupId];
    if (!group) return null;
    
    return {
      if: this.get(group.if),
      elif: group.elif.map(id => this.get(id)),
      else: group.else ? this.get(group.else) : null
    };
  }

  getConditionalElements(groupId) {
    const group = this.#ir.conditionalGroups[groupId];
    if (!group) return [];
    
    const elements = [group.if, ...group.elif];
    if (group.else) elements.push(group.else);
    return elements;
  }

  validateConditionalGroups() {
    const errors = [];
    
    for (const [groupId, group] of Object.entries(this.#ir.conditionalGroups)) {
      // Must have IF
      if (!group.if) {
        errors.push({ groupId, message: 'Group missing IF' });
        continue;
      }
      
      const ifEl = this.#ir.elements.nodes[group.if];
      if (!ifEl) {
        errors.push({ groupId, message: 'IF element not found' });
        continue;
      }
      
      // Check IF has expression
      if (!ifEl.control?.expr) {
        errors.push({ groupId, elementId: group.if, message: 'IF missing expression' });
      }
      
      // Check all ELIFs have expression
      group.elif.forEach(elifId => {
        const elifEl = this.#ir.elements.nodes[elifId];
        if (!elifEl?.control?.expr) {
          errors.push({ groupId, elementId: elifId, message: 'ELIF missing expression' });
        }
      });
      
      // Check ELSE has no expression
      if (group.else) {
        const elseEl = this.#ir.elements.nodes[group.else];
        if (elseEl?.control?.expr) {
          errors.push({ groupId, elementId: group.else, message: 'ELSE cannot have expression' });
        }
      }
      
      // Check all elements are siblings
      const allIds = [group.if, ...group.elif, group.else].filter(Boolean);
      const parents = new Set(allIds.map(id => this.#ir.elements.nodes[id]?.parent));
      if (parents.size > 1) {
        errors.push({ groupId, message: 'Conditional elements must be siblings' });
      }
    }
    
    return { valid: errors.length === 0, errors };
  }

  // ==================== LOOP (EACH) ====================
  
  setLoop(elementId, { source, alias, index = null, key = null }) {
    this.#ensureTx('setLoop');
    
    const el = this.#ir.elements.nodes[elementId];
    if (!el) throw new Error(`Element ${elementId} not found`);
    
    // Validate source is array variable
    const sourceVar = this.getVar(source);
    if (!sourceVar) throw new Error(`Variable ${source} not found`);
    
    el.loop = { source, alias, index, key };
    this.#dirty('loops', elementId);
    this.#dirty('elements', elementId);
  }

  removeLoop(elementId) {
    this.#ensureTx('removeLoop');
    
    const el = this.#ir.elements.nodes[elementId];
    if (!el) throw new Error(`Element ${elementId} not found`);
    
    el.loop = null;
    this.#dirty('loops', elementId);
    this.#dirty('elements', elementId);
  }

  updateLoop(elementId, config) {
    this.#ensureTx('updateLoop');
    
    const el = this.#ir.elements.nodes[elementId];
    if (!el || !el.loop) throw new Error('Element has no loop');
    
    el.loop = { ...el.loop, ...config };
    this.#dirty('loops', elementId);
    this.#dirty('elements', elementId);
  }

  getLoop(elementId) {
    const el = this.#ir.elements.nodes[elementId];
    return el?.loop ? { ...el.loop } : null;
  }

  isLooped(elementId) {
    return !!this.#ir.elements.nodes[elementId]?.loop;
  }

  getLoopScope(elementId) {
    const el = this.#ir.elements.nodes[elementId];
    if (!el?.loop) return null;
    
    return {
      source: el.loop.source,
      alias: el.loop.alias,
      index: el.loop.index,
      key: el.loop.key
    };
  }

  validateLoops() {
    const errors = [];
    
    Object.values(this.#ir.elements.nodes).forEach(el => {
      if (!el.loop) return;
      
      // Check source exists
      const sourceVar = this.getVar(el.loop.source);
      if (!sourceVar) {
        errors.push({ elementId: el.id, message: `Source variable ${el.loop.source} not found` });
      }
      
      // Check alias is valid identifier
      if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(el.loop.alias)) {
        errors.push({ elementId: el.id, message: `Invalid alias: ${el.loop.alias}` });
      }
      
      // Check index if provided
      if (el.loop.index && !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(el.loop.index)) {
        errors.push({ elementId: el.id, message: `Invalid index: ${el.loop.index}` });
      }
    });
    
    return { valid: errors.length === 0, errors };
  }

  // ==================== EVENT ====================
  
  on(target, type, action) {
    this.#ensureTx('on');
    if (!this.#ir.events[type]) this.#ir.events[type] = [];
    
    this.#ir.events[type].push({ id: this.id('evt'), target, action });
    this.#dirty('events', target);
  }

  off(target, type) {
    this.#ensureTx('off');
    if (this.#ir.events[type]) {
      this.#ir.events[type] = this.#ir.events[type].filter(e => e.target !== target);
    }
    this.#dirty('events', target);
  }

  // ==================== VARIABLE ====================
  
  var({ name, type, init = null, source = null, lifecycle = null }) {
    this.#ensureTx('var');
    
    const existing = this.getVar(name);
    if (existing) throw new Error(`Variable ${name} already exists`);
    
    this.#ir.variables[type].push({
      id: this.id('var'),
      name, type, init,
      source: type === 'fetch' ? source : null,
      lifecycle: type === 'fetch' ? lifecycle : null
    });
    
    this.#dirty('variables', name);
  }

  deleteVar(name) {
    this.#ensureTx('deleteVar');
    
    let found = false;
    for (const type in this.#ir.variables) {
      const idx = this.#ir.variables[type].findIndex(v => v.name === name);
      if (idx !== -1) {
        this.#ir.variables[type].splice(idx, 1);
        found = true;
        break;
      }
    }
    
    if (!found) throw new Error(`Variable ${name} not found`);
    
    this.#ir.bindings = this.#ir.bindings.filter(b => b.variable !== name);
    this.#dirty('variables', name);
  }

  updateVar(name, value) {
    this.#ensureTx('updateVar');
    
    const v = this.getVar(name);
    if (!v) throw new Error(`Variable ${name} not found`);
    if (v.type === 'static') throw new Error('Cannot update static variable');
    
    v.init = value;
    this.#dirty('variables', name);
  }

  // ==================== BINDING ====================
  
  bind({ elementId, variable, kind, key = null }) {
    this.#ensureTx('bind');
    
    const el = this.#ir.elements.nodes[elementId];
    if (!el) throw new Error(`Element ${elementId} not found`);
    
    const v = this.getVar(variable);
    if (!v) throw new Error(`Variable ${variable} not found`);
    
    this.#ir.bindings.push({ id: this.id('bind'), elementId, variable, kind, key });
    
    if (kind === 'text') {
      el.textBinding = variable;
      el.text = null;
    }
    
    this.#dirty('bindings', elementId);
    this.#dirty('elements', elementId);
  }

  unbind(elementId, variable) {
    this.#ensureTx('unbind');
    
    const el = this.#ir.elements.nodes[elementId];
    if (!el) throw new Error(`Element ${elementId} not found`);
    
    this.#ir.bindings = this.#ir.bindings.filter(b => !(b.elementId === elementId && b.variable === variable));
    
    if (el.textBinding === variable) el.textBinding = null;
    
    this.#dirty('bindings', elementId);
    this.#dirty('elements', elementId);
  }

  // ==================== MACRO ====================
  
  duplicate(id) {
    return this.tx('duplicate', () => {
      const el = this.#ir.elements.nodes[id];
      if (!el) throw new Error(`Element ${id} not found`);
      
      const newId = this.#duplicateRecursive(id);
      
      if (el.parent) {
        const parent = this.#ir.elements.nodes[el.parent];
        const idx = parent.children.indexOf(id);
        this.insert(el.parent, newId, idx + 1);
      }
      
      return newId;
    });
  }

  #duplicateRecursive(id) {
    const el = this.#ir.elements.nodes[id];
    const newId = this.create({ kind: el.kind, tag: el.tag });
    const newEl = this.#ir.elements.nodes[newId];
    
    newEl.text = el.text;
    newEl.textBinding = el.textBinding;
    newEl.styles = { ...el.styles };
    newEl.classes = new Set(el.classes);
    newEl.attrs = { ...el.attrs };
    newEl.control = el.control ? { ...el.control } : null;
    newEl.loop = el.loop ? { ...el.loop } : null;
    
    for (const childId of el.children) {
      const newChildId = this.#duplicateRecursive(childId);
      this.append(newId, newChildId);
    }
    
    const bindings = this.getBindings(id);
    for (const b of bindings) {
      this.bind({ elementId: newId, variable: b.variable, kind: b.kind, key: b.key });
    }
    
    for (const type in this.#ir.events) {
      const events = this.#ir.events[type].filter(e => e.target === id);
      for (const evt of events) {
        this.on(newId, type, this.#clone(evt.action));
      }
    }
    
    return newId;
  }

  wrap(id) {
    return this.tx('wrap', () => {
      const el = this.#ir.elements.nodes[id];
      if (!el) throw new Error(`Element ${id} not found`);
      
      const containerId = this.create({ kind: 'layout', tag: 'div' });
      
      if (el.parent) {
        const parent = this.#ir.elements.nodes[el.parent];
        const idx = parent.children.indexOf(id);
        this.insert(el.parent, containerId, idx);
        parent.children = parent.children.filter(c => c !== id);
      }
      
      this.append(containerId, id);
      return containerId;
    });
  }

  convert(id, newKind) {
    this.tx('convert', () => {
      const el = this.#ir.elements.nodes[id];
      if (!el) throw new Error(`Element ${id} not found`);
      
      el.kind = newKind;
      this.#dirty('elements', id);
      this.#dirty('structure', true);
    });
  }

  // ==================== QUERY ====================
  
  get(id) {
    const el = this.#ir.elements.nodes[id];
    if (!el) return null;
    return {
      ...el,
      classes: new Set(el.classes),
      styles: { ...el.styles },
      attrs: { ...el.attrs },
      children: [...el.children],
      control: el.control ? { ...el.control } : null,
      loop: el.loop ? { ...el.loop } : null
    };
  }

  children(id) {
    return this.#ir.elements.nodes[id]?.children || [];
  }

  parent(id) {
    return this.#ir.elements.nodes[id]?.parent || null;
  }

  vars() {
    const all = [];
    for (const type in this.#ir.variables) {
      all.push(...this.#ir.variables[type].map(v => ({ ...v })));
    }
    return all;
  }

  getVar(name) {
    for (const type in this.#ir.variables) {
      const v = this.#ir.variables[type].find(v => v.name === name);
      if (v) return { ...v };
    }
    return null;
  }

  events(id) {
    const evts = [];
    for (const type in this.#ir.events) {
      const typeEvts = this.#ir.events[type].filter(e => e.target === id);
      evts.push(...typeEvts.map(e => ({ ...e, type, action: this.#clone(e.action) })));
    }
    return evts;
  }

  getBindings(id) {
    return this.#ir.bindings.filter(b => b.elementId === id).map(b => ({ ...b }));
  }

  // ==================== COMPILER BRIDGE ====================
  
  getIR() {
    return this.#freeze(this.#clone(this.#ir));
  }

  // ==================== INTERNAL ====================
  
  #ensureTx(op) {
    if (!this.#txStack.length) throw new Error(`${op} must be in transaction`);
  }

  #dirty(cat, val) {
    if (cat === 'structure') this.#ir.dirtyFlags.structure = val;
    else this.#ir.dirtyFlags[cat].add(val);
  }

  #clone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Set) return new Set([...obj]);
    if (obj instanceof Map) return new Map([...obj]);
    if (Array.isArray(obj)) return obj.map(item => this.#clone(item));
    
    const cloned = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) cloned[key] = this.#clone(obj[key]);
    }
    return cloned;
  }

  #freeze(obj) {
    Object.freeze(obj);
    Object.getOwnPropertyNames(obj).forEach(prop => {
      if (obj[prop] && typeof obj[prop] === 'object' && !Object.isFrozen(obj[prop])) {
        this.#freeze(obj[prop]);
      }
    });
    return obj;
  }
}
/**
 * IRCompiler - Compile IR ke JavaScript dengan IF/ELSE dan LOOP support
 * Ultra minimal boilerplate, maximum efficiency
 */

/**
 * IRCompiler - Node-Based Architecture
 * No more string concatenation, pure tree traversal
 */

/**
 * IRCompiler - Node-Based Architecture
 * No more string concatenation, pure tree traversal
 */

class IRCompiler {
  #ir = null;
  #out = { decls: [], vars: [], fns: [], lifecycle: [], cleanup: [] };
  #deps = new Map();
  #nodes = new Map();
  #counter = 0;

  compile(ir) {
    this.#reset(ir);
    this.#buildNodes();
    this.#analyzeDeps();
    this.#generateCode();
    return this.#assemble();
  }

  #reset(ir) {
    this.#ir = ir;
    this.#out = { decls: [], vars: [], fns: [], lifecycle: [], cleanup: [] };
    this.#deps = new Map();
    this.#nodes = new Map();
    this.#counter = 0;
  }

  #uid() { return `_${(++this.#counter).toString(36)}`; }

  // ==================== NODE CLASSES ====================

  #buildNodes() {
    // Expose helper methods to nodes
    this._varFor = (id) => this.#varFor(id);
    this._buildElementNode = (id, loopScope) => this.#buildElementNode(id, loopScope);
    this._access = (varName) => this.#access(varName);
    this._val = (v) => this.#val(v);
    this._deps = this.#deps;

    // Build variable nodes
    [...this.#ir.variables.static, ...this.#ir.variables.reactive, ...this.#ir.variables.fetch]
      .forEach(v => this.#nodes.set(v.name, new VarNode(v, this)));

    // Build element tree
    if (this.#ir.elements.rootId) {
      this.#nodes.set('root', this.#buildElementNode(this.#ir.elements.rootId));
    }

    // Build conditional groups
    Object.entries(this.#ir.conditionalGroups).forEach(([gid, group]) => {
      this.#nodes.set(gid, new CondNode(gid, group, this.#ir, this));
    });
  }

  #buildElementNode(id, loopScope = null) {
    const el = this.#ir.elements.nodes[id];
    if (!el) return null;

    // Check if part of conditional
    if (el.control) {
      return null; // Handled by CondNode
    }

    // Check if loop
    if (el.loop) {
      return new LoopNode(id, el, this.#ir, this, loopScope);
    }

    return new ElNode(id, el, this.#ir, this, loopScope);
  }

  #analyzeDeps() {
    [...this.#ir.variables.static, ...this.#ir.variables.reactive, ...this.#ir.variables.fetch]
      .forEach(v => this.#deps.set(v.name, { type: v.type, subs: new Set() }));

    this.#ir.bindings.forEach(b => this.#deps.get(b.variable)?.subs.add(b.elementId));

    Object.values(this.#ir.events).flat().forEach(e => {
      if (e.action?.target) this.#deps.get(e.action.target)?.subs.add(e.target);
    });

    Object.values(this.#ir.conditionalGroups).forEach(g => {
      [g.if, ...g.elif].filter(Boolean).forEach(eid => {
        const el = this.#ir.elements.nodes[eid];
        if (el?.control?.expr) {
          this.#extractVars(el.control.expr).forEach(v => {
            this.#deps.get(v)?.subs.add(el.control.group);
          });
        }
      });
    });

    Object.values(this.#ir.elements.nodes).forEach(el => {
      if (el.loop) this.#deps.get(el.loop.source)?.subs.add(el.id);
    });
  }

  #extractVars(expr) {
    const vars = new Set();
    // Simple regex to find identifiers
    const matches = expr.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) || [];
    matches.forEach(m => {
      if (this.#deps.has(m)) vars.add(m);
    });
    return vars;
  }

  #generateCode() {
    // Variables
    this.#nodes.forEach(node => {
      if (node instanceof VarNode) {
        this.#out.vars.push(...node.gen());
      }
    });

    // Root element tree
    const root = this.#nodes.get('root');
    if (root) {
      this.#out.decls.push(...root.decls());
      
      // Generate _create function
      const createFn = [
        `function _create() {`,
        ...root.gen(1),
        `  return ${root.v};`,
        `}`
      ];
      this.#out.fns.push(createFn);
    }

    // Conditional groups
    Object.keys(this.#ir.conditionalGroups).forEach(gid => {
      const node = this.#nodes.get(gid);
      if (node) {
        this.#out.decls.push(...node.decls());
        this.#out.fns.push(...node.gen());
        this.#out.lifecycle.push(...node.init());
      }
    });

    // Bindings
    this.#genBindings();

    // Events
    this.#genEvents();
  }

  #genBindings() {
    const byVar = new Map();
    this.#ir.bindings.forEach(b => {
      if (!byVar.has(b.variable)) byVar.set(b.variable, []);
      byVar.get(b.variable).push(b);
    });

    byVar.forEach((bindings, varName) => {
      const fn = [`function _u_${varName}() {`];
      bindings.forEach(b => {
        const v = this.#varFor(b.elementId);
        const acc = this.#access(varName);
        if (b.kind === 'text') fn.push(`  if (${v}) ${v}.textContent = ${acc};`);
        if (b.kind === 'attr') fn.push(`  if (${v}) ${v}.setAttribute("${b.key}", ${acc});`);
        if (b.kind === 'style') fn.push(`  if (${v}) ${v}.style.${this.#camel(b.key)} = ${acc};`);
      });
      fn.push(`}`);
      this.#out.fns.push(fn);
      this.#out.lifecycle.push(`_u_${varName}();`);
    });
  }

  #genEvents() {
    const handlers = [];
    const attach = [`function _attach() {`];

    Object.entries(this.#ir.events).forEach(([type, events]) => {
      events.forEach((e, i) => {
        const v = this.#varFor(e.target);
        const h = `_h${i}_${type}`;
        handlers.push(this.#genHandler(h, e.action));
        attach.push(`  if (${v}) ${v}.addEventListener("${type}", ${h});`);
        this.#out.cleanup.push(`if (${v}) ${v}.removeEventListener("${type}", ${h});`);
      });
    });

    attach.push(`}`);
    if (handlers.length) this.#out.fns.push(handlers);
    this.#out.fns.push(attach);
    this.#out.lifecycle.push(`_attach();`);
  }

  #genHandler(name, action) {
    if (!action) return `const ${name} = () => {};`;
    const lines = [`const ${name} = e => {`];
    
    if (action.kind === 'Update') {
      const acc = this.#access(action.target);
      const op = action.op || '=';
      lines.push(op === '=' 
        ? `  ${acc} = ${this.#val(action.value)};`
        : `  ${acc} ${op} ${this.#val(action.value)};`
      );
    } else if (action.kind === 'Set') {
      lines.push(`  ${this.#access(action.target)} = ${this.#val(action.value)};`);
    } else if (action.kind === 'Call') {
      lines.push(`  ${action.function}();`);
    }
    
    lines.push(`};`);
    return lines;
  }

  #varFor(elId) {
    return `e${elId.split('_')[1] || this.#uid()}`;
  }

  #access(varName) {
    const dep = this.#deps.get(varName);
    return dep && (dep.type === 'reactive' || dep.type === 'fetch') ? `${varName}.value` : varName;
  }

  #assemble() {
    const lines = [
      `// Generated ${new Date().toISOString()}`,
      `// Node-based compiler - Zero runtime\n`
    ];

    if (this.#out.decls.length) {
      lines.push(`// References`);
      this.#out.decls.flat().forEach(d => lines.push(d));
      lines.push('');
    }

    if (this.#out.vars.length) {
      lines.push(`// State`);
      this.#out.vars.flat().forEach(v => lines.push(v));
      lines.push('');
    }

    if (this.#out.fns.length) {
      lines.push(`// Functions`);
      this.#out.fns.flat().forEach(f => {
        if (Array.isArray(f)) lines.push(...f, '');
        else lines.push(f, '');
      });
    }

    lines.push(
      `// Mount`,
      `function mount(target) {`,
      `  const root = _create();`,
      `  target.appendChild(root);\n`
    );

    this.#out.lifecycle.forEach(l => lines.push(`  ${l}`));

    lines.push(
      `\n  return {`,
      `    destroy() {`
    );

    this.#out.cleanup.forEach(c => lines.push(`      ${c}`));

    lines.push(
      `      root.remove();`,
      `    }`,
      `  };`,
      `}\n`,
      `export { mount };`
    );

    return lines.join('\n');
  }

  #val(v) {
    if (v == null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `[${v.map(x => this.#val(x)).join(', ')}]`;
    if (typeof v === 'object') {
      const pairs = Object.entries(v).map(([k, val]) => `${k}: ${this.#val(val)}`);
      return `{${pairs.join(', ')}}`;
    }
    return 'null';
  }

  #camel(s) {
    return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  debug() {
    return {
      nodes: this.#nodes.size,
      deps: this.#deps.size,
      bindings: this.#ir.bindings.length,
      events: Object.values(this.#ir.events).flat().length
    };
  }
}

// ==================== NODE CLASSES ====================

class VarNode {
  constructor(spec, compiler) {
    this.spec = spec;
    this.c = compiler;
  }

  gen() {
    const { name, type, init } = this.spec;
    const v = this.c._val || ((x) => JSON.stringify(x));
    
    if (type === 'static') {
      return [`let ${name} = ${v(init)};`];
    }

    if (type === 'reactive') {
      const hasSubs = this.c._deps?.get?.(name)?.subs?.size > 0;
      return [
        `let _${name} = ${v(init)};`,
        `let ${name} = {`,
        `  get value() { return _${name}; },`,
        `  set value(v) {`,
        `    if (_${name} !== v) {`,
        `      _${name} = v;`,
        hasSubs ? `      _u_${name}();` : '',
        `    }`,
        `  }`,
        `};`
      ].filter(Boolean);
    }

    if (type === 'fetch') {
      return [
        `let _${name} = null;`,
        `let _${name}_loading = true;`,
        `let _${name}_error = null;`,
        `let ${name} = {`,
        `  get value() { return _${name}; },`,
        `  get loading() { return _${name}_loading; },`,
        `  get error() { return _${name}_error; }`,
        `};`
      ];
    }

    return [];
  }
}

class ElNode {
  constructor(id, el, ir, compiler, loopScope) {
    this.id = id;
    this.el = el;
    this.ir = ir;
    this.c = compiler;
    this.v = compiler._varFor(id);
    this.loopScope = loopScope;
    this.children = el.children
      .map(cid => compiler._buildElementNode(cid, loopScope))
      .filter(Boolean);
  }

  decls() {
    const decls = [`let ${this.v};`];
    this.children.forEach(c => decls.push(...c.decls()));
    return decls;
  }

  gen(indent = 1) {
    const p = '  '.repeat(indent);
    const lines = [`${p}${this.v} = document.createElement("${this.el.tag}");`];

    if (this.el.text != null) {
      lines.push(`${p}${this.v}.textContent = ${JSON.stringify(this.el.text)};`);
    }

    Object.entries(this.el.styles).forEach(([k, val]) => {
      const prop = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      lines.push(`${p}${this.v}.style.${prop} = ${JSON.stringify(val)};`);
    });

    if (this.el.classes.size) {
      const cls = [...this.el.classes].map(c => JSON.stringify(c)).join(', ');
      lines.push(`${p}${this.v}.classList.add(${cls});`);
    }

    Object.entries(this.el.attrs).forEach(([k, val]) => {
      lines.push(`${p}${this.v}.setAttribute("${k}", ${JSON.stringify(val)});`);
    });

    this.children.forEach(c => {
      lines.push(...c.gen(indent + 1));
      lines.push(`${p}${this.v}.appendChild(${c.v});`);
    });

    return lines;
  }
}

class LoopNode {
  constructor(id, el, ir, compiler, loopScope) {
    this.id = id;
    this.el = el;
    this.ir = ir;
    this.c = compiler;
    this.v = compiler._varFor(id);
    this.fn = `_loop${id.split('_')[1]}`;
    this.scope = { ...loopScope, [el.loop.alias]: el.loop.alias };
    this.children = el.children
      .map(cid => compiler._buildElementNode(cid, this.scope))
      .filter(Boolean);
  }

  decls() {
    return [`let ${this.v};`];
  }

  gen(indent = 1) {
    const p = '  '.repeat(indent);
    const { source, alias, index } = this.el.loop;
    
    const fn = [
      `function ${this.fn}() {`,
      `  const frag = document.createDocumentFragment();`,
      `  const src = ${this.c._access(source)};`,
      `  if (Array.isArray(src)) {`,
      `    src.forEach((${alias}${index ? `, ${index}` : ''}) => {`,
      `      const el = document.createElement("${this.el.tag}");`
    ];

    if (this.el.text != null) {
      fn.push(`      el.textContent = ${JSON.stringify(this.el.text)};`);
    }

    if (this.el.textBinding) {
      fn.push(`      el.textContent = ${this.el.textBinding};`);
    }

    Object.entries(this.el.styles).forEach(([k, val]) => {
      const prop = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      fn.push(`      el.style.${prop} = ${JSON.stringify(val)};`);
    });

    this.children.forEach(c => {
      fn.push(...this.#genLoopChild(c, 3));
    });

    fn.push(
      `      frag.appendChild(el);`,
      `    });`,
      `  }`,
      `  return frag;`,
      `}`
    );

    return [[`${p}${this.v} = ${this.fn}();`], fn];
  }

  #genLoopChild(child, indent) {
    const p = '  '.repeat(indent);
    const cv = `c${child.id.split('_')[1]}`;
    const lines = [`${p}const ${cv} = document.createElement("${child.el.tag}");`];

    if (child.el.textBinding) {
      lines.push(`${p}${cv}.textContent = ${child.el.textBinding};`);
    } else if (child.el.text != null) {
      lines.push(`${p}${cv}.textContent = ${JSON.stringify(child.el.text)};`);
    }

    Object.entries(child.el.styles).forEach(([k, val]) => {
      const prop = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      lines.push(`${p}${cv}.style.${prop} = ${JSON.stringify(val)};`);
    });

    child.children?.forEach(gc => {
      lines.push(...this.#genLoopChild(gc, indent + 1));
    });

    lines.push(`${p}el.appendChild(${cv});`);
    return lines;
  }
}

class CondNode {
  constructor(gid, group, ir, compiler) {
    this.gid = gid;
    this.group = group;
    this.ir = ir;
    this.c = compiler;
    this.anchor = `_a${gid.split('_')[1]}`;
    this.current = `_c${gid.split('_')[1]}`;
    this.createFn = `_cc${gid.split('_')[1]}`;
    this.updateFn = `_cu${gid.split('_')[1]}`;
  }

  decls() {
    const decls = [`let ${this.anchor};`, `let ${this.current};`];
    
    [this.group.if, ...this.group.elif, this.group.else].filter(Boolean).forEach(eid => {
      const el = this.ir.elements.nodes[eid];
      if (el) {
        const v = this.c._varFor(eid);
        decls.push(`let ${v};`);
      }
    });

    return decls;
  }

  gen() {
    const create = [`function ${this.createFn}() {`];

    // IF
    const ifEl = this.ir.elements.nodes[this.group.if];
    if (ifEl) {
      create.push(`  if (${ifEl.control.expr}) {`);
      create.push(...this.#genBranch(this.group.if, 2));
      create.push(`    return ${this.c._varFor(this.group.if)};`);
      create.push(`  }`);
    }

    // ELIF
    this.group.elif.forEach(eid => {
      const el = this.ir.elements.nodes[eid];
      if (el) {
        create.push(`  else if (${el.control.expr}) {`);
        create.push(...this.#genBranch(eid, 2));
        create.push(`    return ${this.c._varFor(eid)};`);
        create.push(`  }`);
      }
    });

    // ELSE
    if (this.group.else) {
      create.push(`  else {`);
      create.push(...this.#genBranch(this.group.else, 2));
      create.push(`    return ${this.c._varFor(this.group.else)};`);
      create.push(`  }`);
    }

    create.push(`  return null;`, `}`);

    const update = [
      `function ${this.updateFn}() {`,
      `  if (${this.current}) ${this.current}.remove();`,
      `  ${this.current} = ${this.createFn}();`,
      `  if (${this.current} && ${this.anchor}) {`,
      `    ${this.anchor}.parentNode.insertBefore(${this.current}, ${this.anchor}.nextSibling);`,
      `  }`,
      `}`
    ];

    return [create, update];
  }

  #genBranch(eid, indent) {
    const el = this.ir.elements.nodes[eid];
    if (!el) return [];
    
    const p = '  '.repeat(indent);
    const v = this.c._varFor(eid);
    const lines = [`${p}${v} = document.createElement("${el.tag}");`];

    if (el.text != null) {
      lines.push(`${p}${v}.textContent = ${JSON.stringify(el.text)};`);
    }

    Object.entries(el.styles).forEach(([k, val]) => {
      const prop = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      lines.push(`${p}${v}.style.${prop} = ${JSON.stringify(val)};`);
    });

    return lines;
  }

  init() {
    return [`${this.updateFn}();`];
  }
}

// ==================== EXAMPLE ====================

const ir = new IRManager();

ir.tx('app', () => {
  ir.var({ name: 'count', type: 'reactive', init: 0 });

  const root = ir.create({ 
    kind: 'layout', 
    tag: 'div',
    styles: { padding: '20px', fontFamily: 'Arial' }
  });

  const title = ir.create({ kind: 'text', tag: 'h1', parent: root });
  ir.bindText(title, 'count');

  const { groupId } = ir.createIfGroup(root, {
    expr: 'count.value === 0',
    element: { kind: 'text', tag: 'p', text: 'Zero!', styles: { color: 'gray' } }
  });

  ir.addElse(groupId, {
    element: { kind: 'text', tag: 'p', text: 'Not zero!', styles: { color: 'green' } }
  });

  const btn = ir.create({ kind: 'button', tag: 'button', text: 'Inc', parent: root });
  ir.on(btn, 'click', { kind: 'Update', target: 'count', op: '+=', value: 1 });
});

const compiler = new IRCompiler();
const code = compiler.compile(ir.getIR());

console.log(code);
console.log('\nDebug:', compiler.debug());

/**
 * VisualAPI - Bridge antara Visual Builder UI dan IRManager
 * Single source of truth, semua operasi melalui IRManager
 */

class VisualAPI {
  constructor(irManager) {
    this.ir = irManager;
    this.onChangeCallbacks = [];
    this.onPreviewIntentCallbacks = [];
    this.onErrorCallbacks = [];
    this.rootId = null;
    this.selectedId = null;
    this.clipboard = null;
  }

  // ==================== ROOT ====================
  
  addRoot(spec = {}) {
    return this.ir.tx('add root', () => {
      const id = this.ir.create({ 
        kind: 'layout', 
        tag: spec.tag || 'div',
        ...spec 
      });
      this.rootId = id;
      this._change('root_added', { rootId: id });
      return id;
    });
  }

  getRoot() {
    return this.rootId;
  }

  // ==================== ELEMENT LIFECYCLE ====================
  
  add(parentId, spec) {
    return this.ir.tx('add element', () => {
      const id = this.ir.create({ ...spec, parent: parentId });
      this._change('element_added', { elementId: id, parentId });
      return id;
    });
  }

  delete(elementId) {
    return this.ir.tx('delete element', () => {
      const el = this.ir.get(elementId);
      if (!el) throw new Error(`Element ${elementId} not found`);
      
      this.ir.delete(elementId);
      
      if (this.selectedId === elementId) this.selectedId = null;
      this._change('element_deleted', { elementId });
    });
  }

  duplicate(elementId) {
    return this.ir.tx('duplicate element', () => {
      const newId = this.ir.duplicate(elementId);
      this._change('element_duplicated', { originalId: elementId, newId });
      return newId;
    });
  }

  move(elementId, newParentId, index = null) {
    return this.ir.tx('move element', () => {
      if (index !== null) {
        this.ir.insert(newParentId, elementId, index);
      } else {
        this.ir.append(newParentId, elementId);
      }
      this._change('element_moved', { elementId, newParentId, index });
    });
  }

  insertBefore(targetId, spec) {
    return this.ir.tx('insert before', () => {
      const target = this.ir.get(targetId);
      if (!target || !target.parent) throw new Error('Target has no parent');
      
      const parentId = target.parent;
      const siblings = this.ir.children(parentId);
      const index = siblings.indexOf(targetId);
      
      const newId = this.ir.create({ ...spec, parent: parentId });
      this.ir.insert(parentId, newId, index);
      
      this._change('element_inserted', { elementId: newId, targetId, position: 'before' });
      return newId;
    });
  }

  insertAfter(targetId, spec) {
    return this.ir.tx('insert after', () => {
      const target = this.ir.get(targetId);
      if (!target || !target.parent) throw new Error('Target has no parent');
      
      const parentId = target.parent;
      const siblings = this.ir.children(parentId);
      const index = siblings.indexOf(targetId);
      
      const newId = this.ir.create({ ...spec, parent: parentId });
      this.ir.insert(parentId, newId, index + 1);
      
      this._change('element_inserted', { elementId: newId, targetId, position: 'after' });
      return newId;
    });
  }

  wrap(elementId, containerSpec = {}) {
    return this.ir.tx('wrap element', () => {
      const containerId = this.ir.wrap(elementId);
      
      // Apply container spec
      if (containerSpec.tag) {
        const container = this.ir.get(containerId);
        container.tag = containerSpec.tag;
      }
      if (containerSpec.styles) {
        Object.entries(containerSpec.styles).forEach(([k, v]) => {
          this.ir.style(containerId, k, v);
        });
      }
      
      this._change('element_wrapped', { elementId, containerId });
      return containerId;
    });
  }

  unwrap(elementId) {
    return this.ir.tx('unwrap element', () => {
      const el = this.ir.get(elementId);
      if (!el || !el.parent) throw new Error('Cannot unwrap root or orphan');
      
      const parentId = el.parent;
      const grandparentId = this.ir.parent(parentId);
      if (!grandparentId) throw new Error('Parent has no parent');
      
      // Move children of parent to grandparent
      const siblings = this.ir.children(parentId);
      const index = siblings.indexOf(elementId);
      
      siblings.forEach(childId => {
        this.ir.append(grandparentId, childId);
      });
      
      // Delete wrapper
      this.ir.delete(parentId);
      
      this._change('element_unwrapped', { elementId, wrapperId: parentId });
    });
  }

  // ==================== ATTRIBUTES ====================
  
  attr(elementId, name, value = null) {
    return this.ir.tx('set attribute', () => {
      this.ir.attr(elementId, name, value);
      this._change('attribute_changed', { elementId, name, value });
    });
  }

  attrs(elementId, attrsObj) {
    return this.ir.tx('set attributes', () => {
      Object.entries(attrsObj).forEach(([k, v]) => {
        this.ir.attr(elementId, k, v);
      });
      this._change('attributes_changed', { elementId, attrs: attrsObj });
    });
  }

  // ==================== STYLES ====================
  
  style(elementId, prop, value = null) {
    return this.ir.tx('set style', () => {
      this.ir.style(elementId, prop, value);
      this._change('style_changed', { elementId, prop, value });
    });
  }

  styles(elementId, stylesObj) {
    return this.ir.tx('set styles', () => {
      Object.entries(stylesObj).forEach(([k, v]) => {
        this.ir.style(elementId, k, v);
      });
      this._change('styles_changed', { elementId, styles: stylesObj });
    });
  }

  // ==================== CLASSES ====================
  
  addClass(elementId, className) {
    return this.ir.tx('add class', () => {
      this.ir.class(elementId, className, true);
      this._change('class_added', { elementId, className });
    });
  }

  removeClass(elementId, className) {
    return this.ir.tx('remove class', () => {
      this.ir.class(elementId, className, false);
      this._change('class_removed', { elementId, className });
    });
  }

  toggleClass(elementId, className) {
    return this.ir.tx('toggle class', () => {
      const el = this.ir.get(elementId);
      const has = el.classes.has(className);
      this.ir.class(elementId, className, !has);
      this._change('class_toggled', { elementId, className, active: !has });
    });
  }

  // ==================== TEXT & BINDINGS ====================
  
  text(elementId, text) {
    return this.ir.tx('set text', () => {
      // Check if contains binding syntax {{var}}
      const bindingMatch = text.match(/^\{\{(.+)\}\}$/);
      if (bindingMatch) {
        const varName = bindingMatch[1].trim();
        this.ir.bindText(elementId, varName);
        this._change('text_bound', { elementId, variable: varName });
      } else {
        this.ir.setText(elementId, text);
        this._change('text_changed', { elementId, text });
      }
    });
  }

  bindText(elementId, variableName) {
    return this.ir.tx('bind text', () => {
      this.ir.bindText(elementId, variableName);
      this._change('text_bound', { elementId, variable: variableName });
    });
  }

  unbindText(elementId) {
    return this.ir.tx('unbind text', () => {
      this.ir.unbindText(elementId);
      this._change('text_unbound', { elementId });
    });
  }

  // ==================== EVENTS ====================
  
  on(elementId, type, action) {
    return this.ir.tx('add event', () => {
      this.ir.on(elementId, type, action);
      this._change('event_added', { elementId, type, action });
    });
  }

  off(elementId, type) {
    return this.ir.tx('remove event', () => {
      this.ir.off(elementId, type);
      this._change('event_removed', { elementId, type });
    });
  }

  // ==================== VARIABLES ====================
  
  var(spec) {
    return this.ir.tx('create variable', () => {
      this.ir.var(spec);
      this._change('variable_created', { name: spec.name, type: spec.type });
    });
  }

  updateVar(name, value) {
    return this.ir.tx('update variable', () => {
      this.ir.updateVar(name, value);
      this._change('variable_updated', { name, value });
    });
  }

  deleteVar(name) {
    return this.ir.tx('delete variable', () => {
      this.ir.deleteVar(name);
      this._change('variable_deleted', { name });
    });
  }

  // ==================== BINDINGS ====================
  
  bind(elementId, variable, kind, key = null) {
    return this.ir.tx('create binding', () => {
      this.ir.bind({ elementId, variable, kind, key });
      this._change('binding_created', { elementId, variable, kind, key });
    });
  }

  unbind(elementId, variable) {
    return this.ir.tx('remove binding', () => {
      this.ir.unbind(elementId, variable);
      this._change('binding_removed', { elementId, variable });
    });
  }

  // ==================== LOOPS ====================
  
  loop(elementId, config) {
    return this.ir.tx('create loop', () => {
      this.ir.setLoop(elementId, config);
      this._change('loop_created', { elementId, config });
    });
  }

  updateLoop(elementId, config) {
    return this.ir.tx('update loop', () => {
      this.ir.updateLoop(elementId, config);
      this._change('loop_updated', { elementId, config });
    });
  }

  removeLoop(elementId) {
    return this.ir.tx('remove loop', () => {
      this.ir.removeLoop(elementId);
      this._change('loop_removed', { elementId });
    });
  }

  // ==================== CONDITIONALS ====================
  
  if(parentId, { expr, element }) {
    return this.ir.tx('create if', () => {
      const result = this.ir.createIfGroup(parentId, { expr, element });
      this._change('conditional_created', { 
        groupId: result.groupId, 
        elementId: result.elementId,
        type: 'if' 
      });
      return result;
    });
  }

  elif(groupId, { expr, element }) {
    return this.ir.tx('add elif', () => {
      const elementId = this.ir.addElif(groupId, { expr, element });
      this._change('conditional_created', { 
        groupId, 
        elementId,
        type: 'elif' 
      });
      return elementId;
    });
  }

  else(groupId, { element }) {
    return this.ir.tx('add else', () => {
      const elementId = this.ir.addElse(groupId, { element });
      this._change('conditional_created', { 
        groupId, 
        elementId,
        type: 'else' 
      });
      return elementId;
    });
  }

  updateCondition(elementId, expr) {
    return this.ir.tx('update condition', () => {
      this.ir.updateCondition(elementId, expr);
      this._change('condition_updated', { elementId, expr });
    });
  }

  removeConditional(elementId) {
    return this.ir.tx('remove conditional', () => {
      this.ir.removeConditional(elementId);
      this._change('conditional_removed', { elementId });
    });
  }

  // ==================== SELECTION ====================
  
  select(elementId) {
    this.selectedId = elementId;
    this._change('selection_changed', { elementId });
    return elementId;
  }

  deselect() {
    this.selectedId = null;
    this._change('selection_cleared');
  }

  getSelected() {
    return this.selectedId;
  }

  // ==================== CLIPBOARD ====================
  
  copy(elementId) {
    const el = this.ir.get(elementId);
    if (!el) throw new Error('Element not found');
    this.clipboard = { type: 'element', data: el };
    this._change('copied', { elementId });
  }

  cut(elementId) {
    this.copy(elementId);
    this.clipboard.cut = true;
    this._change('cut', { elementId });
  }

  paste(parentId) {
    if (!this.clipboard) throw new Error('Clipboard is empty');
    
    return this.ir.tx('paste', () => {
      if (this.clipboard.cut) {
        // Move
        this.move(this.clipboard.data.id, parentId);
        this.clipboard = null;
      } else {
        // Duplicate
        const newId = this.duplicate(this.clipboard.data.id);
        this.move(newId, parentId);
        return newId;
      }
    });
  }

  // ==================== QUERY / INSPECTION ====================
  
  get(elementId) {
    return this.ir.get(elementId);
  }

  children(elementId) {
    return this.ir.children(elementId);
  }

  parent(elementId) {
    return this.ir.parent(elementId);
  }

  siblings(elementId) {
    const parentId = this.ir.parent(elementId);
    if (!parentId) return [];
    return this.ir.children(parentId).filter(id => id !== elementId);
  }

  tree(rootId = this.rootId) {
    if (!rootId) return null;
    
    const buildTree = (id) => {
      const el = this.ir.get(id);
      if (!el) return null;
      
      return {
        ...el,
        children: el.children.map(buildTree).filter(Boolean)
      };
    };
    
    return buildTree(rootId);
  }

  vars() {
    return this.ir.vars();
  }

  getVar(name) {
    return this.ir.getVar(name);
  }

  events(elementId) {
    return this.ir.events(elementId);
  }

  bindings(elementId) {
    return this.ir.getBindings(elementId);
  }

  getLoop(elementId) {
    return this.ir.getLoop(elementId);
  }

  // ==================== VALIDATION ====================
  
  validate() {
    const errors = [];
    
    // Validate conditionals
    const condResult = this.ir.validateConditionalGroups();
    if (!condResult.valid) {
      errors.push(...condResult.errors.map(e => ({ type: 'conditional', ...e })));
    }
    
    // Validate loops
    const loopResult = this.ir.validateLoops();
    if (!loopResult.valid) {
      errors.push(...loopResult.errors.map(e => ({ type: 'loop', ...e })));
    }
    
    return { valid: errors.length === 0, errors };
  }

  // ==================== UNDO/REDO ====================
  
  undo() {
    const success = this.ir.undo();
    if (success) this._change('undo');
    return success;
  }

  redo() {
    const success = this.ir.redo();
    if (success) this._change('redo');
    return success;
  }

  canUndo() {
    return this.ir.canUndo();
  }

  canRedo() {
    return this.ir.canRedo();
  }

  // ==================== SNAPSHOT ====================
  
  snapshot() {
    return this.ir.getIR();
  }

  // ==================== PREVIEW ====================
  
  preview(compiler) {
    try {
      const ir = this.snapshot();
      const code = compiler.compile(ir);
      this._preview({ success: true, code });
      return code;
    } catch (error) {
      this._preview({ success: false, error: error.message });
      this._error('preview_failed', error);
      throw error;
    }
  }

  // ==================== HOOKS ====================
  
  onChange(callback) {
    this.onChangeCallbacks.push(callback);
    return () => {
      this.onChangeCallbacks = this.onChangeCallbacks.filter(cb => cb !== callback);
    };
  }

  onPreview(callback) {
    this.onPreviewIntentCallbacks.push(callback);
    return () => {
      this.onPreviewIntentCallbacks = this.onPreviewIntentCallbacks.filter(cb => cb !== callback);
    };
  }

  onError(callback) {
    this.onErrorCallbacks.push(callback);
    return () => {
      this.onErrorCallbacks = this.onErrorCallbacks.filter(cb => cb !== callback);
    };
  }

  // ==================== INTERNAL ====================
  
  _change(type, data = {}) {
    const snapshot = this.snapshot();
    const event = {
      type,
      timestamp: Date.now(),
      data,
      snapshot,
      canUndo: this.canUndo(),
      canRedo: this.canRedo()
    };
    
    this.onChangeCallbacks.forEach(cb => {
      try {
        cb(event);
      } catch (error) {
        console.error('Change callback error:', error);
      }
    });
  }

  _preview(data) {
    this.onPreviewIntentCallbacks.forEach(cb => {
      try {
        cb(data);
      } catch (error) {
        console.error('Preview callback error:', error);
      }
    });
  }

  _error(type, error) {
    this.onErrorCallbacks.forEach(cb => {
      try {
        cb({ type, error, timestamp: Date.now() });
      } catch (err) {
        console.error('Error callback error:', err);
      }
    });
  }

  // ==================== HELPERS ====================
  
  find(predicate) {
    const results = [];
    const traverse = (id) => {
      const el = this.ir.get(id);
      if (!el) return;
      
      if (predicate(el)) results.push(el);
      el.children.forEach(traverse);
    };
    
    if (this.rootId) traverse(this.rootId);
    return results;
  }

  findById(id) {
    return this.ir.get(id);
  }

  findByKind(kind) {
    return this.find(el => el.kind === kind);
  }

  findByTag(tag) {
    return this.find(el => el.tag === tag);
  }

  findByClass(className) {
    return this.find(el => el.classes.has(className));
  }
}

// ==================== USAGE EXAMPLE ====================

// Initialize

const visual = new VisualAPI(ir);
