/**
 * @license
 * Copyright 2016 Google Inc. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import './x-trap-focus.js';
import './x-a.js';

const template = document.createElement('template');
template.innerHTML = `
  <style>
    :host {
      display: block;
      border: 1px solid red;
      padding: 5px;
      margin: 5px;
    }
  </style>
  <button>x-b</button>
  <x-trap-focus class="in-x-b">
    <x-a class="in-x-b">
      <button>in x-b</button>
      <slot id="xb"></slot>
    </x-a>
  </x-trap-focus>`;

class XB extends HTMLElement {
  connectedCallback() {
    const clone = document.importNode(template.content, true);
    this.attachShadow({
      mode: 'open'
    }).appendChild(clone);
  }
}
customElements.define('x-b', XB);
