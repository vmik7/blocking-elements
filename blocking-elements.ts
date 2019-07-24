/**
 * @license
 * Copyright 2016 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

(function() {
/* Symbols for private properties */
const _blockingElements = Symbol();
const _alreadyInertElements = Symbol();
const _topElParents = Symbol();
const _siblingsToRestore = Symbol();
const _parentMO = Symbol();

/* Symbols for private static methods */
const _topChanged = Symbol();
const _swapInertedSibling = Symbol();
const _inertSiblings = Symbol();
const _restoreInertedSiblings = Symbol();
const _getParents = Symbol();
const _getDistributedChildren = Symbol();
const _isInertable = Symbol();
const _handleMutations = Symbol();

interface DocumentWithBlockingElements extends Document {
  $blockingElements: BlockingElements;
}

interface IntertableHTMLElement extends HTMLElement {
  inert?: boolean;
  [_siblingsToRestore]?: Set<IntertableHTMLElement>;
  [_parentMO]?: MutationObserver;
}

/**
 * `BlockingElements` manages a stack of elements that inert the interaction
 * outside them. The top element is the interactive part of the document.
 * The stack can be updated with the methods `push, remove, pop`.
 */
class BlockingElements {
  /**
   * The blocking elements.
   */
  private[_blockingElements]: IntertableHTMLElement[] = [];

  /**
   * Used to keep track of the parents of the top element, from the element
   * itself up to body. When top changes, the old top might have been removed
   * from the document, so we need to memoize the inerted parents' siblings
   * in order to restore their inerteness when top changes.
   */
  private[_topElParents]: IntertableHTMLElement[] = [];

  /**
   * Elements that are already inert before the first blocking element is
   * pushed.
   */
  private[_alreadyInertElements] = new Set<IntertableHTMLElement>();

  /**
   * Call this whenever this object is about to become obsolete. This empties
   * the blocking elements
   */
  destructor() {
    // Restore original inertness.
    this[_restoreInertedSiblings](this[_topElParents]);
    const nullable = this as unknown as {
      [_blockingElements]: null;
      [_topElParents]: null;
      [_alreadyInertElements]: null;
    };
    nullable[_blockingElements] = null;
    nullable[_topElParents] = null;
    nullable[_alreadyInertElements] = null;
  }

  /**
   * The top blocking element.
   */
  get top(): HTMLElement|null {
    const elems = this[_blockingElements];
    return elems[elems.length - 1] || null;
  }

  /**
   * Adds the element to the blocking elements.
   */
  push(element: HTMLElement): HTMLElement|undefined {
    if (!element || element === this.top) {
      return;
    }
    // Remove it from the stack, we'll bring it to the top.
    this.remove(element);
    this[_topChanged](element);
    this[_blockingElements].push(element);
  }

  /**
   * Removes the element from the blocking elements. Returns true if the element
   * was removed.
   */
  remove(element: HTMLElement): boolean {
    const i = this[_blockingElements].indexOf(element);
    if (i === -1) {
      return false;
    }
    this[_blockingElements].splice(i, 1);
    // Top changed only if the removed element was the top element.
    if (i === this[_blockingElements].length) {
      const top = this.top;
      if (top !== null) {
        this[_topChanged](top);
      }
    }
    return true;
  }

  /**
   * Remove the top blocking element and returns it.
   */
  pop(): HTMLElement|null {
    const top = this.top;
    top && this.remove(top);
    return top;
  }

  /**
   * Returns if the element is a blocking element.
   */
  has(element: HTMLElement): boolean {
    return this[_blockingElements].indexOf(element) !== -1;
  }

  /**
   * Sets `inert` to all document elements except the new top element, its
   * parents, and its distributed content.
   */
  private[_topChanged](newTop: HTMLElement|null): void {
    const toKeepInert = this[_alreadyInertElements];
    const oldParents = this[_topElParents];
    // No new top, reset old top if any.
    if (!newTop) {
      this[_restoreInertedSiblings](oldParents);
      toKeepInert.clear();
      this[_topElParents] = [];
      return;
    }

    const newParents = this[_getParents](newTop);
    // New top is not contained in the main document!
    if (newParents[newParents.length - 1].parentNode !== document.body) {
      throw Error('Non-connected element cannot be a blocking element');
    }
    this[_topElParents] = newParents;

    const toSkip = this[_getDistributedChildren](newTop);

    // No previous top element.
    if (!oldParents.length) {
      this[_inertSiblings](newParents, toSkip, toKeepInert);
      return;
    }

    let i = oldParents.length - 1;
    let j = newParents.length - 1;
    // Find common parent. Index 0 is the element itself (so stop before it).
    while (i > 0 && j > 0 && oldParents[i] === newParents[j]) {
      i--;
      j--;
    }
    // If up the parents tree there are 2 elements that are siblings, swap
    // the inerted sibling.
    if (oldParents[i] !== newParents[j]) {
      this[_swapInertedSibling](oldParents[i], newParents[j]);
    }
    // Restore old parents siblings inertness.
    i > 0 && this[_restoreInertedSiblings](oldParents.slice(0, i));
    // Make new parents siblings inert.
    j > 0 && this[_inertSiblings](newParents.slice(0, j), toSkip, null);
  }

  /**
   * Swaps inertness between two sibling elements.
   * Sets the property `inert` over the attribute since the inert spec
   * doesn't specify if it should be reflected.
   * https://html.spec.whatwg.org/multipage/interaction.html#inert
   */
  private[_swapInertedSibling](
      oldInert: IntertableHTMLElement, newInert: IntertableHTMLElement): void {
    const siblingsToRestore = oldInert[_siblingsToRestore];
    // oldInert is not contained in siblings to restore, so we have to check
    // if it's inertable and if already inert.
    if (this[_isInertable](oldInert) && !oldInert.inert) {
      oldInert.inert = true;
      if (siblingsToRestore) {
        siblingsToRestore.add(oldInert);
      }
    }
    // If newInert was already between the siblings to restore, it means it is
    // inertable and must be restored.
    if (siblingsToRestore && siblingsToRestore.has(newInert)) {
      newInert.inert = false;
      siblingsToRestore.delete(newInert);
    }
    newInert[_parentMO] = oldInert[_parentMO];
    oldInert[_parentMO] = undefined;
    newInert[_siblingsToRestore] = siblingsToRestore;
    oldInert[_siblingsToRestore] = undefined;
  }

  /**
   * Restores original inertness to the siblings of the elements.
   * Sets the property `inert` over the attribute since the inert spec
   * doesn't specify if it should be reflected.
   * https://html.spec.whatwg.org/multipage/interaction.html#inert
   */
  private[_restoreInertedSiblings](elements: IntertableHTMLElement[]) {
    elements.forEach((el) => {
      const mo = el[_parentMO];
      if (mo !== undefined) {
        mo.disconnect();
      }
      el[_parentMO] = undefined;
      const siblings = el[_siblingsToRestore];
      if (siblings !== undefined) {
        for (const sibling of siblings) {
          sibling.inert = false;
        }
      }
      el[_siblingsToRestore] = undefined;
    });
  }

  /**
   * Inerts the siblings of the elements except the elements to skip. Stores
   * the inerted siblings into the element's symbol `_siblingsToRestore`.
   * Pass `toKeepInert` to collect the already inert elements.
   * Sets the property `inert` over the attribute since the inert spec
   * doesn't specify if it should be reflected.
   * https://html.spec.whatwg.org/multipage/interaction.html#inert
   */
  private[_inertSiblings](
      elements: IntertableHTMLElement[], toSkip: Set<HTMLElement>|null,
      toKeepInert: Set<HTMLElement>|null) {
    for (const element of elements) {
      const children =
          element.parentNode !== null ? element.parentNode.children : [];
      const inertedSiblings = new Set<HTMLElement>();
      for (let j = 0; j < children.length; j++) {
        const sibling = children[j] as IntertableHTMLElement;
        // Skip the input element, if not inertable or to be skipped.
        if (sibling === element || !this[_isInertable](sibling) ||
            (toSkip && toSkip.has(sibling))) {
          continue;
        }
        // Should be collected since already inerted.
        if (toKeepInert && sibling.inert) {
          toKeepInert.add(sibling);
        } else {
          sibling.inert = true;
          inertedSiblings.add(sibling);
        }
      }
      // Store the siblings that were inerted.
      element[_siblingsToRestore] = inertedSiblings;
      // Observe only immediate children mutations on the parent.
      element[_parentMO] =
          new MutationObserver(this[_handleMutations].bind(this));
      const mo = element[_parentMO];
      if (element.parentNode !== null && mo !== undefined) {
        mo.observe(element.parentNode, {
          childList: true,
        });
      }
    }
  }

  /**
   * Handles newly added/removed nodes by toggling their inertness.
   * It also checks if the current top Blocking Element has been removed,
   * notifying and removing it.
   */
  private[_handleMutations](mutations: MutationRecord[]): void {
    const parents = this[_topElParents];
    const toKeepInert = this[_alreadyInertElements];
    for (const mutation of mutations) {
      const idx = mutation.target === document.body ?
          parents.length :
          parents.indexOf(mutation.target as IntertableHTMLElement);
      const inertedChild = parents[idx - 1];
      const inertedSiblings = inertedChild[_siblingsToRestore];

      // To restore.
      for (let i = 0; i < mutation.removedNodes.length; i++) {
        const sibling = mutation.removedNodes[i] as IntertableHTMLElement;
        if (sibling === inertedChild) {
          console.info('Detected removal of the top Blocking Element.');
          this.pop();
          return;
        }
        if (inertedSiblings && inertedSiblings.has(sibling)) {
          sibling.inert = false;
          inertedSiblings.delete(sibling);
        }
      }

      // To inert.
      for (let i = 0; i < mutation.addedNodes.length; i++) {
        const sibling = mutation.removedNodes[i] as IntertableHTMLElement;
        if (!this[_isInertable](sibling)) {
          continue;
        }
        if (toKeepInert && sibling.inert) {
          toKeepInert.add(sibling);
        } else {
          sibling.inert = true;
          if (inertedSiblings) {
            inertedSiblings.add(sibling);
          }
        }
      }
    }
  }

  /**
   * Returns if the element is inertable.
   */
  private[_isInertable](element: HTMLElement): boolean {
    return false === /^(style|template|script)$/.test(element.localName);
  }

  /**
   * Returns the list of newParents of an element, starting from element
   * (included) up to `document.body` (excluded).
   */
  private[_getParents](element: HTMLElement): Array<HTMLElement> {
    const parents = [];
    let current: HTMLElement|null|undefined = element;
    // Stop to body.
    while (current && current !== document.body) {
      // Skip shadow roots.
      if (current.nodeType === Node.ELEMENT_NODE) {
        parents.push(current);
      }
      // ShadowDom v1
      if ((current as HTMLElement).assignedSlot) {
        // Collect slots from deepest slot to top.
        while ((current = (current as HTMLElement).assignedSlot)) {
          parents.push(current);
        }
        // Continue the search on the top slot.
        current = parents.pop();
        continue;
      }
      current = current.parentNode as HTMLElement ||
          (current as Node as ShadowRoot).host;
    }
    return parents;
  }

  /**
   * Returns the distributed children of the element's shadow root.
   * Returns null if the element doesn't have a shadow root.
   */
  private[_getDistributedChildren](element: HTMLElement):
      Set<HTMLElement>|null {
    const shadowRoot = element.shadowRoot;
    if (!shadowRoot) {
      return null;
    }
    const result = new Set<HTMLElement>();
    let i;
    let j;
    let nodes;
    const slots = shadowRoot.querySelectorAll('slot');
    if (slots.length && slots[0].assignedNodes) {
      for (i = 0; i < slots.length; i++) {
        nodes = slots[i].assignedNodes({
          flatten: true,
        });
        for (j = 0; j < nodes.length; j++) {
          if (nodes[j].nodeType === Node.ELEMENT_NODE) {
            result.add(nodes[j] as HTMLElement);
          }
        }
      }
      // No need to search for <content>.
    }
    return result;
  }
}

(document as DocumentWithBlockingElements).$blockingElements =
    new BlockingElements();
})();
