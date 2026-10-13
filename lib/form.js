// Mirrors the router's own form handling (common.js: postTableEncrypt) so that
// every POST we send looks exactly like one sent by the router's web page.
'use strict';
const { parse } = require('node-html-parser');

// Same encoding rules as the router's JS (encodeURIComponent + !'()~ escaped, %20 -> +)
function encVal(v) {
  return encodeURIComponent(v == null ? '' : String(v))
    .replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28')
    .replace(/\)/g, '%29').replace(/~/g, '%7E').replace(/%20/g, '+');
}
function encName(n) {
  return String(n).replace(/\[/g, '%5B').replace(/\]/g, '%5D');
}

// Literal port of the router's checksum loop.
function checksum(inputVal) {
  let csum = 0, i = 0;
  while (i < inputVal.length) {
    if (i + 4 > inputVal.length) {
      if (i < inputVal.length) csum += (inputVal.charCodeAt(i) << 24);
      if (i + 1 < inputVal.length) csum += (inputVal.charCodeAt(i + 1) << 16);
      if (i + 2 < inputVal.length) csum += (inputVal.charCodeAt(i + 2) << 8);
      break;
    } else {
      csum += (inputVal.charCodeAt(i) << 24) + (inputVal.charCodeAt(i + 1) << 16) +
              (inputVal.charCodeAt(i + 2) << 8) + inputVal.charCodeAt(i + 3);
      i += 4;
    }
  }
  csum = (csum & 0xffff) + (csum >> 16);
  csum = csum & 0xffff;
  csum = (~csum) & 0xffff;
  return csum;
}

// Read a <form> into an ordered list of controls with their default state.
function readForm(formEl) {
  const controls = [];
  for (const el of formEl.querySelectorAll('input, select, textarea')) {
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    const c = {
      tag, name, disabled: el.hasAttribute('disabled'),
      type: tag === 'select' ? (el.hasAttribute('multiple') ? 'select-multiple' : 'select-one')
          : tag === 'textarea' ? 'textarea'
          : (el.getAttribute('type') || 'text').toLowerCase(),
    };
    if (tag === 'select') {
      c.options = el.querySelectorAll('option').map(o => ({
        value: o.hasAttribute('value') ? o.getAttribute('value') : o.text.trim(),
        text: o.text.trim(), selected: o.hasAttribute('selected'),
      }));
      const sel = c.options.findIndex(o => o.selected);
      c.selectedIndex = c.options.length ? (sel >= 0 ? sel : 0) : -1;
      c.value = c.selectedIndex >= 0 ? c.options[c.selectedIndex].value : '';
    } else if (tag === 'textarea') {
      c.value = el.text;
    } else {
      c.value = el.hasAttribute('value') ? el.getAttribute('value') : (c.type === 'checkbox' || c.type === 'radio' ? 'on' : '');
      c.checked = el.hasAttribute('checked');
      c.onclick = el.getAttribute('onclick') || '';
    }
    controls.push(c);
  }
  return controls;
}

function findForm(html, pred) {
  const root = parse(html);
  const forms = root.querySelectorAll('form');
  const f = typeof pred === 'function' ? forms.find(pred)
    : typeof pred === 'number' ? forms[pred]
    : forms.find(x => x.getAttribute('name') === pred || x.getAttribute('id') === pred);
  if (!f) throw new Error('Form not found on page');
  return { el: f, action: f.getAttribute('action') || '', controls: readForm(f) };
}

/**
 * Set values on a form, like a user would.
 *  set: { name: value }   — text/hidden/select(value or option text)
 *       { name: true/false } — checkbox
 *       { name: "value" } on a radio group — picks that radio
 *  For repeated names (e.g. comment[]), pass { "comment[]": ["a"] } to fill the first N.
 */
function applyValues(controls, set = {}) {
  const counters = {};
  for (const c of controls) {
    if (!c.name || !(c.name in set)) continue;
    let v = set[c.name];
    if (Array.isArray(v) && c.type !== 'radio') {
      const k = counters[c.name] = (counters[c.name] || 0);
      counters[c.name]++;
      if (k >= v.length) continue;
      v = v[k];
    }
    if (c.type === 'checkbox') c.checked = !!v;
    else if (c.type === 'radio') c.checked = String(c.value) === String(v);
    else if (c.type === 'select-one') {
      let idx = c.options.findIndex(o => String(o.value) === String(v));
      if (idx < 0) idx = c.options.findIndex(o => o.text.toLowerCase() === String(v).toLowerCase());
      if (idx < 0) throw new Error(`Option "${v}" not available for ${c.name}`);
      c.selectedIndex = idx; c.value = c.options[idx].value;
    } else c.value = v;
  }
}

// Build the body exactly in document order, plus the checksum.
function serialize(controls, clickName) {
  let inputVal = '';
  let clicked = false;
  for (const c of controls) {
    if (!c.name || c.name === 'postSecurityFlag' || c.name === 'csrftoken') continue;
    if (c.disabled) continue;
    if (c.type === 'submit' || c.type === 'reset' || c.type === 'button' || c.type === 'image') {
      if (clickName && c.name === clickName && !clicked) {
        clicked = true;
        inputVal += encName(c.name) + '=' + encVal(c.value) + '&';
      }
      continue;
    }
    if (c.type === 'radio' || c.type === 'checkbox') {
      if (c.checked) inputVal += encName(c.name) + '=' + encVal(c.value) + '&';
    } else if (c.type === 'select-one' || c.type === 'select-multiple') {
      if (c.value !== '') inputVal += encName(c.name) + '=' + encVal(c.value) + '&';
      else if (c.selectedIndex >= 0 && c.options[c.selectedIndex].text !== '')
        inputVal += encName(c.name) + '=' + encVal(c.options[c.selectedIndex].text).replace(/\[/g, '%5B').replace(/\]/g, '%5D') + '&';
    } else {
      inputVal += encName(c.name) + '=' + encVal(c.value) + '&';
    }
  }
  if (clickName && !clicked) throw new Error(`Button ${clickName} not found in form`);
  const flag = checksum(inputVal);
  return { inputVal, flag, body: inputVal + 'postSecurityFlag=' + flag };
}

module.exports = { encVal, encName, checksum, readForm, findForm, applyValues, serialize };
