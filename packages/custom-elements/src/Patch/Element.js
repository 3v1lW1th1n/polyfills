import Native from './Native.js';
import CustomElementInternals from '../CustomElementInternals.js';
import CEState from '../CustomElementState.js';
import * as Utilities from '../Utilities.js';

import PatchParentNode from './Interface/ParentNode.js';
import PatchChildNode from './Interface/ChildNode.js';

/**
 * @param {!CustomElementInternals} internals
 */
export default function(internals) {
  if (Native.Element_attachShadow) {
    Utilities.setPropertyUnchecked(Element.prototype, 'attachShadow',
      /**
       * @this {Element}
       * @param {!{mode: string}} init
       * @return {ShadowRoot}
       */
      function(init) {
        const shadowRoot = Native.Element_attachShadow.call(this, init);
        this.__CE_shadowRoot = shadowRoot;
        return shadowRoot;
      });
  }

  function patch_HTMLsetter(destination, property, baseDescriptor, patchCallback) {
    Object.defineProperty(destination, property, {
      enumerable: baseDescriptor.enumerable,
      configurable: true,
      get: baseDescriptor.get,
      set: /** @this {Element} */ function(htmlString) {
        const isConnected = Utilities.isConnected(this);

        // NOTE: In IE11, when using the native `innerHTML` setter, all nodes
        // that were previously descendants of the context element have all of
        // their children removed as part of the set - the entire subtree is
        // 'disassembled'. This work around walks the subtree *before* using the
        // native setter.
        /** @type {!Array<!Element>|undefined} */
        let removedElements = undefined;
        if (isConnected) {
          removedElements = [];
          Utilities.walkDeepDescendantElements(this, element => {
            if (element !== this) {
              removedElements.push(element);
            }
          });
        }

        // Memoize properties here before calling the baseDescriptor
        // In the case of `outerHTML`, this node would already be disconnected
        // and the properties therefore no longer exist
        const parentNode = this.parentNode;
        const previousSibling = this.previousSibling;
        const nextSibling = this.nextSibling;

        baseDescriptor.set.call(this, htmlString);

        if (removedElements) {
          for (let i = 0; i < removedElements.length; i++) {
            const element = removedElements[i];
            if (element.__CE_state === CEState.custom) {
              internals.disconnectedCallback(element);
            }
          }
        }

        // Only create custom elements if this element's owner document is
        // associated with the registry.
        if (!this.ownerDocument.__CE_hasRegistry) {
          patchCallback(this, internals.patchTree, {parentNode, previousSibling, nextSibling});
        } else {
          patchCallback(this, internals.patchAndUpgradeTree, {parentNode, previousSibling, nextSibling});
        }
        return htmlString;
      },
    });
  }

  function patch_innerHTML(destination, baseDescriptor) {
    patch_HTMLsetter(destination, 'innerHTML', baseDescriptor, (node, patchFunction) => {
      patchFunction.call(internals, node);
    });
  }

  if (Native.Element_innerHTML && Native.Element_innerHTML.get) {
    patch_innerHTML(Element.prototype, Native.Element_innerHTML);
  } else if (Native.HTMLElement_innerHTML && Native.HTMLElement_innerHTML.get) {
    patch_innerHTML(HTMLElement.prototype, Native.HTMLElement_innerHTML);
  } else {

    internals.addPatch(function(element) {
      patch_innerHTML(element, {
        enumerable: true,
        configurable: true,
        // Implements getting `innerHTML` by performing an unpatched `cloneNode`
        // of the element and returning the resulting element's `innerHTML`.
        // TODO: Is this too expensive?
        get: /** @this {Element} */ function() {
          return Native.Node_cloneNode.call(this, true).innerHTML;
        },
        // Implements setting `innerHTML` by creating an unpatched element,
        // setting `innerHTML` of that element and replacing the target
        // element's children with those of the unpatched element.
        set: /** @this {Element} */ function(assignedValue) {
          // NOTE: re-route to `content` for `template` elements.
          // We need to do this because `template.appendChild` does not
          // route into `template.content`.
          const isTemplate = (this.localName === 'template');
          /** @type {!Node} */
          const content = isTemplate ? (/** @type {!HTMLTemplateElement} */
            (this)).content : this;
          /** @type {!Node} */
          const rawElement = Native.Document_createElementNS.call(document,
              this.namespaceURI, this.localName);
          rawElement.innerHTML = assignedValue;

          while (content.childNodes.length > 0) {
            Native.Node_removeChild.call(content, content.childNodes[0]);
          }
          const container = isTemplate ? rawElement.content : rawElement;
          while (container.childNodes.length > 0) {
            Native.Node_appendChild.call(content, container.childNodes[0]);
          }
        },
      });
    });
  }

  function patch_outerHTML(destination, baseDescriptor) {
    patch_HTMLsetter(destination, 'outerHTML', baseDescriptor, (node, patchFunction, {parentNode, previousSibling, nextSibling}) => {
      if (parentNode === null) {
        throw new Error(`Failed to set the 'outerHTML' property on 'Element': This element has no parent node.`);
      }
      if (previousSibling === null && nextSibling === null) {
        patchFunction.call(internals, parentNode);
      } else {
        let sibling = previousSibling && previousSibling.nextSibling || parentNode.firstChild;

        while (sibling !== null && sibling !== nextSibling) {
          patchFunction.call(internals, sibling);
          sibling = sibling.nextSibling;
        }
      }
    });
  }

  if (Native.Element_outerHTML && Native.Element_outerHTML.get) {
    patch_outerHTML(Element.prototype, Native.Element_outerHTML);
  } else if (Native.HTMLElement_outerHTML && Native.HTMLElement_outerHTML.get) {
    patch_outerHTML(HTMLElement.prototype, Native.HTMLElement_outerHTML);
  } else {

    internals.addPatch(function(element) {
      patch_outerHTML(element, {
        enumerable: true,
        configurable: true,
        // Implements getting `outerHTML` by performing an unpatched `cloneNode`
        // of the element and returning the resulting element's `outerHTML`.
        // TODO: Is this too expensive?
        get: /** @this {Element} */ function() {
          return Native.Node_cloneNode.call(this, true).outerHTML;
        },
        set: /** @this {Element} */ function(assignedValue) {
          const container = Native.Document_createElementNS.call(document,
            this.parentNode.namespaceURI || this.namespaceURI, this.parentNode.localName || this.localName);
          container.innerHTML = assignedValue;

          while (container.childNodes.length > 0) {
            Native.Node_insertBefore.call(this.parentNode, container.childNodes[0], this);
          }

          Native.Node_removeChild.call(this.parentNode, this);

          return assignedValue;
        },
      });
    });
  }


  Utilities.setPropertyUnchecked(Element.prototype, 'setAttribute',
    /**
     * @this {Element}
     * @param {string} name
     * @param {string} newValue
     */
    function(name, newValue) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CEState.custom) {
        return Native.Element_setAttribute.call(this, name, newValue);
      }

      const oldValue = Native.Element_getAttribute.call(this, name);
      Native.Element_setAttribute.call(this, name, newValue);
      newValue = Native.Element_getAttribute.call(this, name);
      internals.attributeChangedCallback(this, name, oldValue, newValue, null);
    });

  Utilities.setPropertyUnchecked(Element.prototype, 'setAttributeNS',
    /**
     * @this {Element}
     * @param {?string} namespace
     * @param {string} name
     * @param {string} newValue
     */
    function(namespace, name, newValue) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CEState.custom) {
        return Native.Element_setAttributeNS.call(this, namespace, name, newValue);
      }

      const oldValue = Native.Element_getAttributeNS.call(this, namespace, name);
      Native.Element_setAttributeNS.call(this, namespace, name, newValue);
      newValue = Native.Element_getAttributeNS.call(this, namespace, name);
      internals.attributeChangedCallback(this, name, oldValue, newValue, namespace);
    });

  Utilities.setPropertyUnchecked(Element.prototype, 'removeAttribute',
    /**
     * @this {Element}
     * @param {string} name
     */
    function(name) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CEState.custom) {
        return Native.Element_removeAttribute.call(this, name);
      }

      const oldValue = Native.Element_getAttribute.call(this, name);
      Native.Element_removeAttribute.call(this, name);
      if (oldValue !== null) {
        internals.attributeChangedCallback(this, name, oldValue, null, null);
      }
    });

  Utilities.setPropertyUnchecked(Element.prototype, 'removeAttributeNS',
    /**
     * @this {Element}
     * @param {?string} namespace
     * @param {string} name
     */
    function(namespace, name) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CEState.custom) {
        return Native.Element_removeAttributeNS.call(this, namespace, name);
      }

      const oldValue = Native.Element_getAttributeNS.call(this, namespace, name);
      Native.Element_removeAttributeNS.call(this, namespace, name);
      // In older browsers, `Element#getAttributeNS` may return the empty string
      // instead of null if the attribute does not exist. For details, see;
      // https://developer.mozilla.org/en-US/docs/Web/API/Element/getAttributeNS#Notes
      const newValue = Native.Element_getAttributeNS.call(this, namespace, name);
      if (oldValue !== newValue) {
        internals.attributeChangedCallback(this, name, oldValue, newValue, namespace);
      }
    });


  function patch_insertAdjacentElement(destination, baseMethod) {
    Utilities.setPropertyUnchecked(destination, 'insertAdjacentElement',
      /**
       * @this {Element}
       * @param {string} position
       * @param {!Element} element
       * @return {?Element}
       */
      function(position, element) {
        const wasConnected = Utilities.isConnected(element);
        const insertedElement = /** @type {!Element} */
          (baseMethod.call(this, position, element));

        if (wasConnected) {
          internals.disconnectTree(element);
        }

        if (Utilities.isConnected(insertedElement)) {
          internals.connectTree(element);
        }
        return insertedElement;
      });
  }

  if (Native.HTMLElement_insertAdjacentElement) {
    patch_insertAdjacentElement(HTMLElement.prototype, Native.HTMLElement_insertAdjacentElement);
  } else if (Native.Element_insertAdjacentElement) {
    patch_insertAdjacentElement(Element.prototype, Native.Element_insertAdjacentElement);
  } else {
    console.warn('Custom Elements: `Element#insertAdjacentElement` was not patched.');
  }


  function patch_insertAdjacentHTML(destination, baseMethod) {
    /**
     * Patches and upgrades all nodes which are siblings between `start`
     * (inclusive) and `end` (exclusive). If `end` is `null`, then all siblings
     * following `start` will be patched and upgraded.
     * @param {!Node} start
     * @param {?Node} end
     */
    function upgradeNodesInRange(start, end) {
      const nodes = [];
      for (let node = start; node !== end; node = node.nextSibling) {
        nodes.push(node);
      }
      for (let i = 0; i < nodes.length; i++) {
        internals.patchAndUpgradeTree(nodes[i]);
      }
    }

    Utilities.setPropertyUnchecked(destination, 'insertAdjacentHTML',
      /**
       * @this {Element}
       * @param {string} position
       * @param {string} text
       */
      function(position, text) {
        position = position.toLowerCase();

        if (position === "beforebegin") {
          const marker = this.previousSibling;
          baseMethod.call(this, position, text);
          upgradeNodesInRange(marker || /** @type {!Node} */ (this.parentNode.firstChild), this);
        } else if (position === "afterbegin") {
          const marker = this.firstChild;
          baseMethod.call(this, position, text);
          upgradeNodesInRange(/** @type {!Node} */ (this.firstChild), marker);
        } else if (position === "beforeend") {
          const marker = this.lastChild;
          baseMethod.call(this, position, text);
          upgradeNodesInRange(marker || /** @type {!Node} */ (this.firstChild), null);
        } else if (position === "afterend") {
          const marker = this.nextSibling;
          baseMethod.call(this, position, text);
          upgradeNodesInRange(/** @type {!Node} */ (this.nextSibling), marker);
        } else {
          throw new SyntaxError(`The value provided (${String(position)}) is ` +
            "not one of 'beforebegin', 'afterbegin', 'beforeend', or 'afterend'.");
        }
      });
  }

  if (Native.HTMLElement_insertAdjacentHTML) {
    patch_insertAdjacentHTML(HTMLElement.prototype, Native.HTMLElement_insertAdjacentHTML);
  } else if (Native.Element_insertAdjacentHTML) {
    patch_insertAdjacentHTML(Element.prototype, Native.Element_insertAdjacentHTML);
  } else {
    console.warn('Custom Elements: `Element#insertAdjacentHTML` was not patched.');
  }


  PatchParentNode(internals, Element.prototype, {
    prepend: Native.Element_prepend,
    append: Native.Element_append,
  });

  PatchChildNode(internals, Element.prototype, {
    before: Native.Element_before,
    after: Native.Element_after,
    replaceWith: Native.Element_replaceWith,
    remove: Native.Element_remove,
  });
};
