/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

import Native from './Native.js';
import CustomElementInternals from '../CustomElementInternals.js';
import * as Utilities from '../Utilities.js';

/**
 * @param {!CustomElementInternals} internals
 */
export default function(internals) {
  // `Node#nodeValue` is implemented on `Attr`.
  // `Node#textContent` is implemented on `Attr`, `Element`.

  Utilities.setPropertyUnchecked(Node.prototype, 'insertBefore',
    /**
     * @this {Node}
     * @param {!Node} node
     * @param {?Node} refNode
     * @return {!Node}
     */
    function(node, refNode) {
      internals.pushCEReactionsQueue();

      if (node instanceof DocumentFragment) {
        // DocumentFragments can't be connected, so `disconnectTree` will never
        // need to be called on a DocumentFragment's children after inserting it.

        if (Utilities.isConnected(this)) {
          internals.connectTree(node);
        }

        const result = Native.Node_insertBefore.call(this, node, refNode);
        internals.popCEReactionsQueue();
        return result;
      }

      const nodeIsElement = node instanceof Element;

      if (nodeIsElement && Utilities.isConnected(node)) {
        internals.disconnectTree(node);
      }

      const nativeResult = Native.Node_insertBefore.call(this, node, refNode);

      if (nodeIsElement && Utilities.isConnected(node)) {
        internals.connectTree(node);
      }

      internals.popCEReactionsQueue();
      return nativeResult;
    });

  Utilities.setPropertyUnchecked(Node.prototype, 'appendChild',
    /**
     * @this {Node}
     * @param {!Node} node
     * @return {!Node}
     */
    function(node) {
      internals.pushCEReactionsQueue();

      if (node instanceof DocumentFragment) {
        // DocumentFragments can't be connected, so `disconnectTree` will never
        // need to be called on a DocumentFragment's children after inserting it.

        if (Utilities.isConnected(this)) {
          internals.connectTree(node);
        }

        const result = Native.Node_appendChild.call(this, node);
        internals.popCEReactionsQueue();
        return result;
      }

      const nodeIsElement = node instanceof Element;

      if (nodeIsElement && Utilities.isConnected(node)) {
        internals.disconnectTree(node);
      }

      const nativeResult = Native.Node_appendChild.call(this, node);

      if (nodeIsElement && Utilities.isConnected(node)) {
        internals.connectTree(node);
      }

      internals.popCEReactionsQueue();
      return nativeResult;
    });

  Utilities.setPropertyUnchecked(Node.prototype, 'cloneNode',
    /**
     * @this {Node}
     * @param {boolean=} deep
     * @return {!Node}
     */
    function(deep) {
      internals.pushCEReactionsQueue();

      const clone = Native.Node_cloneNode.call(this, !!deep);
      // Only create custom elements if this element's owner document is
      // associated with the registry.
      if (!this.ownerDocument.__CE_registry) {
        internals.patchTree(clone);
      } else {
        internals.patchAndUpgradeTree(clone);
      }

      internals.popCEReactionsQueue();
      return clone;
    });

  Utilities.setPropertyUnchecked(Node.prototype, 'removeChild',
    /**
     * @this {Node}
     * @param {!Node} node
     * @return {!Node}
     */
    function(node) {
      internals.pushCEReactionsQueue();

      if (node instanceof Element && Utilities.isConnected(node)) {
        internals.disconnectTree(node);
      }

      const result = Native.Node_removeChild.call(this, node);
      internals.popCEReactionsQueue();
      return result;
    });

  Utilities.setPropertyUnchecked(Node.prototype, 'replaceChild',
    /**
     * @this {Node}
     * @param {!Node} nodeToInsert
     * @param {!Node} nodeToRemove
     * @return {!Node}
     */
    function(nodeToInsert, nodeToRemove) {
      internals.pushCEReactionsQueue();

      const thisIsConnected = Utilities.isConnected(this);

      if (nodeToInsert instanceof DocumentFragment) {
        if (thisIsConnected) {
          internals.disconnectTree(nodeToRemove);

          // DocumentFragments can't be connected, so `disconnectTree` will
          // never need to be called on a DocumentFragment's children after
          // inserting it.

          internals.connectTree(nodeToInsert);
        }

        const result = Native.Node_replaceChild.call(this, nodeToInsert, nodeToRemove);
        internals.popCEReactionsQueue();
        return result;
      }

      if (thisIsConnected) {
        internals.disconnectTree(nodeToRemove);
      }

      if (nodeToInsert instanceof Element) {
        if (Utilities.isConnected(nodeToInsert)) {
          internals.disconnectTree(nodeToInsert);
        }

        if (thisIsConnected) {
          internals.connectTree(nodeToInsert);
        }
      }

      const result = Native.Node_replaceChild.call(this, nodeToInsert, nodeToRemove);
      internals.popCEReactionsQueue();
      return result;
    });


  function patch_textContent(destination, baseDescriptor) {
    Object.defineProperty(destination, 'textContent', {
      enumerable: baseDescriptor.enumerable,
      configurable: true,
      get: baseDescriptor.get,
      set: /** @this {Node} */ function(assignedValue) {
        internals.pushCEReactionsQueue();

        // If this is a text node then there are no nodes to disconnect.
        if (this.nodeType === Node.TEXT_NODE) {
          baseDescriptor.set.call(this, assignedValue);
          internals.popCEReactionsQueue();
          return;
        }

        if (Utilities.isConnected(this)) {
          for (let child = this.firstChild; child; child = child.nextSibling) {
            internals.disconnectTree(child);
          }
        }

        baseDescriptor.set.call(this, assignedValue);

        internals.popCEReactionsQueue();
      },
    });
  }

  if (Native.Node_textContent && Native.Node_textContent.get) {
    patch_textContent(Node.prototype, Native.Node_textContent);
  } else {
    internals.addNodePatch(function(element) {
      patch_textContent(element, {
        enumerable: true,
        configurable: true,
        // NOTE: This implementation of the `textContent` getter assumes that
        // text nodes' `textContent` getter will not be patched.
        get: /** @this {Node} */ function() {
          /** @type {!Array<string>} */
          const parts = [];

          for (let n = this.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === Node.COMMENT_NODE) {
              continue;
            }
            parts.push(n.textContent);
          }

          return parts.join('');
        },
        set: /** @this {Node} */ function(assignedValue) {
          while (this.firstChild) {
            Native.Node_removeChild.call(this, this.firstChild);
          }
          // `textContent = null | undefined | ''` does not result in
          // a TextNode childNode
          if (assignedValue != null && assignedValue !== '') {
            Native.Node_appendChild.call(this, document.createTextNode(assignedValue));
          }
        },
      });
    });
  }
};
