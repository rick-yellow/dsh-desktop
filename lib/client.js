window.__ModuleLoader__.load({
  id: "dsh-awsome-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    // dsh-awsome-plugin: a single dsh client bundle that hosts multiple
    // separable "features". Each feature is { id, name, apply }; register it
    // here, and the plugin's own apply() walks the registry and mounts every
    // (enabled) feature. Adding a capability = implement a feature + call
    // registerFeature(...) — no change to the loader contract.
    const features = [];
    function registerFeature(feature) {
      features.push(feature);
    }

    //#region feature: add-to-chat
    // Select text in a chat message, "Quick Reference" with an optional comment,
    // keep a numbered underline mark on the source message, list the pending
    // annotations in a composer dock, and serialize them into the message on
    // send. Sent messages render the annotations as a collapsible summary.
    const INSTALL_FLAG = "__dshDesktopAddToChatInstalled";
    const CHAT_FLOW_SELECTOR = "[data-chat-flow]";
    const CHAT_ITEM_SELECTOR = "[data-chat-flow-key]";
    const COMPOSER_SELECTOR =
      "[data-composer-card] textarea, [data-composer-seat] textarea";
    const MAX_SELECTION_LENGTH = 6000;
    const SENTINEL = "\u2063";
    const WIRE_START = '<dsh_annotations version="1">\n';
    const WIRE_END = "\n</dsh_annotations>";

    function nodeElement(node) {
      if (!node) return null;
      return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    }

    function isEditableOrInteractive(element) {
      return Boolean(
        element &&
          element.closest(
            "input, textarea, select, button, a, [contenteditable='true'], [role='button']",
          ),
      );
    }

    function selectionDetails() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return null;
      }

      const range = selection.getRangeAt(0);
      const start = nodeElement(range.startContainer);
      const end = nodeElement(range.endContainer);
      const startFlow = start && start.closest(CHAT_FLOW_SELECTOR);
      const endFlow = end && end.closest(CHAT_FLOW_SELECTOR);

      if (
        !startFlow ||
        startFlow !== endFlow ||
        isEditableOrInteractive(start) ||
        isEditableOrInteractive(end)
      ) {
        return null;
      }

      const text = selection
        .toString()
        .replace(/\r\n?/g, "\n")
        .trim()
        .slice(0, MAX_SELECTION_LENGTH);
      if (!text) return null;

      const rects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 || rect.height > 0,
      );
      const rect = rects.at(-1) || range.getBoundingClientRect();
      return {
        text,
        rect,
        rects,
        range: range.cloneRange(),
        sourceKey: start.closest(CHAT_ITEM_SELECTOR)?.dataset.chatFlowKey || "",
      };
    }

    function pointTouchesSelection(details, x, y) {
      if (x === 0 && y === 0) return true;
      return details.rects.some(
        (rect) =>
          x >= rect.left - 4 &&
          x <= rect.right + 4 &&
          y >= rect.top - 4 &&
          y <= rect.bottom + 4,
      );
    }

    function sourceMessageRoot(sourceKey) {
      if (!sourceKey) return null;
      try {
        return document.querySelector(
          `[data-chat-flow-key="${CSS.escape(sourceKey)}"]`,
        );
      } catch (_) {
        return null;
      }
    }

    function collectTextParts(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest("[data-dsh-source-num]")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const parts = [];
      let full = "";
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const value = node.nodeValue || "";
        parts.push({ node, start: full.length, end: full.length + value.length });
        full += value;
      }
      return { parts, full };
    }

    function rangeFromExcerpt(root, excerpt, occurrence = 0) {
      if (!root || !excerpt) return null;
      const { parts, full } = collectTextParts(root);
      let index = -1;
      for (let count = 0; count <= occurrence; count += 1) {
        index = full.indexOf(excerpt, index + 1);
        if (index < 0) return null;
      }
      const end = index + excerpt.length;
      const range = document.createRange();
      let started = false;
      for (const part of parts) {
        if (!started && part.start <= index && index < part.end) {
          range.setStart(part.node, index - part.start);
          started = true;
        }
        if (started && part.start < end && end <= part.end) {
          range.setEnd(part.node, end - part.start);
          return range;
        }
      }
      return null;
    }

    function unwrapSourceMark(mark) {
      if (!(mark instanceof Element) || mark.closest("[data-dsh-add-to-chat]")) {
        return;
      }
      mark
        .querySelectorAll("[data-dsh-source-num]")
        .forEach((node) => node.remove());
      const parent = mark.parentNode;
      if (!parent) {
        mark.remove();
        return;
      }
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }

    function textNodesInRange(range) {
      const ancestor =
        range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      if (!ancestor) return [];
      const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
          if (
            node.parentElement?.closest(
              "[data-dsh-source-num], [data-dsh-source-mark], [data-dsh-add-to-chat], [data-dsh-annotation-dock]",
            )
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (
          range.startContainer === node &&
          range.startOffset === node.nodeValue.length
        ) {
          continue;
        }
        if (range.endContainer === node && range.endOffset === 0) continue;
        nodes.push(node);
      }
      return nodes;
    }

    function wrapRangeWithSourceMark(range, annotationId, number) {
      const nodes = textNodesInRange(range);
      if (nodes.length === 0) return false;
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        if (!node.isConnected || !node.nodeValue) continue;
        let start = 0;
        let end = node.nodeValue.length;
        if (node === range.startContainer && node.nodeType === Node.TEXT_NODE) {
          start = Math.min(range.startOffset, node.nodeValue.length);
        }
        if (node === range.endContainer && node.nodeType === Node.TEXT_NODE) {
          end = Math.min(range.endOffset, node.nodeValue.length);
        }
        if (end <= start) continue;
        let target = node;
        if (start > 0) target = node.splitText(start);
        if (end - start < target.nodeValue.length) {
          target.splitText(end - start);
        }
        if (!target.parentNode) continue;
        const mark = document.createElement("span");
        mark.dataset.dshSourceMark = "";
        mark.dataset.dshAnnotationId = String(annotationId);
        target.parentNode.insertBefore(mark, target);
        mark.appendChild(target);
        if (index === nodes.length - 1) {
          const num = document.createElement("span");
          num.dataset.dshSourceNum = "";
          num.textContent = String(number);
          mark.appendChild(num);
        }
      }
      return true;
    }

    function activeComposer() {
      return Array.from(document.querySelectorAll(COMPOSER_SELECTOR)).find(
        (textarea) =>
          textarea instanceof HTMLTextAreaElement &&
          !textarea.disabled &&
          !textarea.readOnly &&
          textarea.getClientRects().length > 0,
      );
    }

    function updateControlledTextarea(textarea, nextValue, focus = false) {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      );
      if (!descriptor || !descriptor.set) return false;
      if (textarea.value === nextValue) {
        if (focus) {
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(nextValue.length, nextValue.length);
        }
        return true;
      }

      descriptor.set.call(textarea, nextValue);
      let event;
      try {
        event = new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: nextValue,
        });
      } catch (_) {
        event = new Event("input", { bubbles: true });
      }
      textarea.dispatchEvent(event);
      if (focus) {
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(nextValue.length, nextValue.length);
      }
      return true;
    }

    function visibleDraft(value) {
      return value.split(SENTINEL).join("");
    }

    function serializeAnnotations(annotations, draft) {
      const rows = annotations.map(({ id, text, comment, sourceKey }) => ({
        id,
        text,
        comment,
        sourceKey,
      }));
      const json = JSON.stringify(rows).replace(/<\//g, "<\\/");
      const prompt = visibleDraft(draft);
      return `${WIRE_START}${json}${WIRE_END}${prompt ? `\n${prompt}` : ""}`;
    }

    function parseWireMessage(raw) {
      if (!raw.startsWith(WIRE_START)) return null;
      const end = raw.indexOf(WIRE_END, WIRE_START.length);
      if (end < 0) return null;
      try {
        const value = JSON.parse(raw.slice(WIRE_START.length, end));
        if (!Array.isArray(value) || value.length === 0) return null;
        const annotations = value
          .filter(
            (row) =>
              row && typeof row === "object" && typeof row.text === "string",
          )
          .map((row, index) => ({
            id: Number.isFinite(row.id) ? row.id : index + 1,
            text: row.text,
            comment: typeof row.comment === "string" ? row.comment : "",
            sourceKey: typeof row.sourceKey === "string" ? row.sourceKey : "",
          }));
        if (annotations.length === 0) return null;
        const prompt = raw.slice(end + WIRE_END.length).replace(/^\n/, "");
        return { annotations, prompt, legacy: false };
      } catch (_) {
        return null;
      }
    }

    function parseLegacyQuote(raw) {
      const lines = raw.replace(/\r\n?/g, "\n").split("\n");
      if (lines[0] !== ">" && !lines[0]?.startsWith("> ")) return null;
      const quoted = [];
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        if (line === ">") quoted.push("");
        else if (line.startsWith("> ")) quoted.push(line.slice(2));
        else break;
        index += 1;
      }
      while (lines[index] === "") index += 1;
      if (quoted.length === 0) return null;
      return {
        annotations: [
          { id: 1, text: quoted.join("\n").trim(), comment: "", sourceKey: "" },
        ],
        prompt: lines.slice(index).join("\n").trim(),
        legacy: true,
      };
    }

    function installGlobalStyles() {
      if (document.querySelector("style[data-dsh-annotation-styles]")) return;
      const style = document.createElement("style");
      style.dataset.dshAnnotationStyles = "";
      style.textContent = `
        [data-dsh-sent-annotations] {
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 10px;
          min-width: min(440px, 55vw);
        }
        [data-dsh-sent-summary] {
          display: inline-flex;
          align-self: flex-start;
          align-items: center;
          gap: 7px;
          min-height: 34px;
          padding: 0 12px;
          border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24));
          border-radius: 999px;
          background: var(--dsw-specific-selector, color-mix(in srgb, var(--dsw-alias-label-primary, #111) 6%, transparent));
          color: inherit;
          font: 600 14px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
          cursor: pointer;
        }
        [data-dsh-sent-summary] svg { flex: none; color: var(--dsw-alias-label-tertiary, #777); }
        [data-dsh-sent-details] {
          display: grid;
          gap: 8px;
          padding: 10px 12px;
          border-left: 3px solid var(--dsw-alias-state-business-primary, #0b84ff);
          border-radius: 6px 12px 12px 6px;
          background: var(--dsw-alias-bg-layer-1, color-mix(in srgb, var(--dsw-alias-label-primary, #111) 5%, transparent));
        }
        [data-dsh-sent-details][hidden] { display: none; }
        [data-dsh-sent-quote] {
          color: var(--dsw-alias-label-secondary, inherit);
          white-space: pre-wrap;
          word-break: break-word;
        }
        [data-dsh-sent-comment] {
          margin-top: 4px;
          color: var(--dsw-alias-label-primary, inherit);
          font-weight: 600;
        }
        [data-dsh-message-main] { white-space: pre-wrap; word-break: break-word; }
        [data-dsh-source-mark] {
          background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #0b84ff) 12%, transparent);
          border-bottom: 2px solid var(--dsw-alias-state-business-primary, #0b84ff);
          box-decoration-break: clone;
          -webkit-box-decoration-break: clone;
          border-radius: 2px;
          color: inherit;
          padding: 0 0.04em 0.06em;
        }
        [data-dsh-source-num] {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 1.15em;
          height: 1.15em;
          margin: 0 0.12em 0 0.22em;
          padding: 0 0.18em;
          border-bottom: 0;
          border-radius: 999px;
          background: var(--dsw-alias-state-business-primary, #0b84ff);
          color: #fff;
          font: 700 10px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
          vertical-align: super;
          user-select: none;
          pointer-events: none;
        }
        @media (max-width: 720px) {
          [data-dsh-sent-annotations] { min-width: 0; }
        }
      `;
      document.head.appendChild(style);
    }

    function installAddToChat() {
      if (window[INSTALL_FLAG] || !document.body) return;
      window[INSTALL_FLAG] = true;
      installGlobalStyles();

      const overlayHost = document.createElement("div");
      overlayHost.dataset.dshAddToChat = "";
      Object.assign(overlayHost.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        pointerEvents: "none",
      });
      document.body.appendChild(overlayHost);

      const shadow = overlayHost.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          :host {
            --accent: var(--dsw-alias-button-info-fill, var(--dsw-alias-state-business-primary, #4d78ef));
            --accent-hover: var(--dsw-alias-button-info-hover, var(--accent));
            --surface: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff)));
            --text: var(--dsw-alias-label-primary, #171717);
            --muted: var(--dsw-alias-label-tertiary, #777);
            --border: var(--dsw-alias-border-l2, rgba(127,127,127,.22));
            color-scheme: inherit;
          }
          * { box-sizing: border-box; }
          .menu, .comment, .badge, .toast { position: fixed; display: none; }
          .menu[data-open="true"], .comment[data-open="true"],
          .badge[data-open="true"], .toast[data-open="true"] { display: flex; }
          .menu {
            min-width: 172px;
            padding: 5px;
            border: 1px solid var(--border);
            border-radius: 12px;
            background: var(--surface);
            box-shadow: var(--dsw-shadow-lv2, 0 12px 36px rgba(0,0,0,.24));
            pointer-events: auto;
          }
          .menu button {
            display: flex;
            align-items: center;
            gap: 9px;
            width: 100%;
            height: 38px;
            padding: 0 10px;
            border: 0;
            border-radius: 8px;
            background: transparent;
            color: var(--text);
            font: 600 14px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
            cursor: pointer;
          }
          .menu button:hover, .menu button:focus-visible {
            background: color-mix(in srgb, var(--text) 9%, transparent);
            outline: none;
          }
          .comment {
            align-items: center;
            width: min(430px, calc(100vw - 24px));
            min-height: 52px;
            padding: 6px 7px 6px 17px;
            border: 1px solid var(--border);
            border-radius: 28px;
            background: var(--surface);
            box-shadow: var(--dsw-shadow-lv2, 0 12px 36px rgba(0,0,0,.22));
            pointer-events: auto;
          }
          .comment input {
            min-width: 0;
            flex: 1;
            border: 0;
            outline: 0;
            background: transparent;
            caret-color: var(--accent);
            color: var(--text);
            font: 15px/22px system-ui, -apple-system, "Segoe UI", sans-serif;
          }
          .comment input::placeholder { color: var(--muted); }
          .comment button {
            display: grid;
            width: 38px;
            height: 38px;
            flex: none;
            place-items: center;
            border: 0;
            border-radius: 999px;
            background: var(--accent);
            color: white;
            cursor: pointer;
          }
          .comment button:hover { background: var(--accent-hover); }
          .comment button:focus-visible,
          .menu button:focus-visible {
            outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
            outline-offset: 2px;
          }
          .badge {
            width: 26px;
            height: 26px;
            align-items: center;
            justify-content: center;
            border: 2px solid var(--surface);
            border-radius: 999px;
            background: var(--accent);
            color: white;
            box-shadow: 0 3px 10px rgba(0,0,0,.2);
            font: 700 13px/1 system-ui, sans-serif;
            pointer-events: none;
          }
          .toast {
            left: 50%;
            bottom: 112px;
            transform: translateX(-50%);
            padding: 8px 12px;
            border-radius: 999px;
            background: var(--dsw-alias-tooltip-bg, color-mix(in srgb, var(--text) 90%, transparent));
            color: var(--dsw-alias-label-primary-inverted, var(--surface));
            font: 600 13px/1.2 system-ui, sans-serif;
            box-shadow: 0 6px 20px rgba(0,0,0,.2);
            pointer-events: none;
          }
        </style>
        <div class="menu" role="menu">
          <button type="button" role="menuitem">
            <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
              <path d="M3.2 2.8h7.1a3 3 0 0 1 3 3v3.4a3 3 0 0 1-3 3H7.1l-3.5 2.1.8-2.5a3 3 0 0 1-2.2-2.9V5.8a3 3 0 0 1 1-3Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
              <path d="M5.2 6.1h5.1M5.2 8.8h3.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            </svg>
            <span>Quick Reference</span>
          </button>
        </div>
        <div class="badge" aria-hidden="true">1</div>
        <div class="comment" role="dialog" aria-label="Add selected text to chat">
          <input type="text" placeholder="Add an optional comment…" aria-label="Optional comment">
          <button type="button" aria-label="Quick Reference" title="Quick Reference">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M9 13.5v-9M5.5 8 9 4.5 12.5 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        <div class="toast" role="status">Added to chat</div>
      `;

      const menu = shadow.querySelector(".menu");
      const menuAction = menu.querySelector("button");
      const badge = shadow.querySelector(".badge");
      const comment = shadow.querySelector(".comment");
      const commentInput = comment.querySelector("input");
      const commentAction = comment.querySelector("button");
      const toast = shadow.querySelector(".toast");

      const dockHost = document.createElement("div");
      dockHost.dataset.dshAnnotationDock = "";
      dockHost.hidden = true;
      dockHost.style.width = "100%";
      const dockShadow = dockHost.attachShadow({ mode: "open" });
      dockShadow.innerHTML = `
        <style>
          :host {
            --accent: var(--dsw-alias-button-info-fill, var(--dsw-alias-state-business-primary, #4d78ef));
            --border: var(--dsw-alias-border-l2, rgba(127,127,127,.2));
            --divider: var(--dsw-alias-border-l1, rgba(127,127,127,.12));
            --muted: var(--dsw-alias-label-tertiary, #81858c);
            --panel-surface: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff)));
            --summary-surface: var(--dsw-specific-selector, var(--dsw-specific-input-major, var(--dsw-alias-bg-base, #fff)));
            display: block;
            color: var(--dsw-alias-label-primary, #171717);
            color-scheme: inherit;
          }
          :host([hidden]) { display: none; }
          * { box-sizing: border-box; }
          .dock {
            position: relative;
            padding: 0 12px 8px;
            font: 14px/1.45 var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif);
          }
          .summary {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-height: 32px;
            padding: 0 11px;
            border: 1px solid var(--border);
            border-radius: 999px;
            background: var(--summary-surface);
            color: inherit;
            font: inherit;
            font-weight: 600;
            cursor: pointer;
            transition: border-color .12s ease, background-color .12s ease;
          }
          .summary:hover {
            background: var(--dsw-alias-interactive-bg-hover-solid, var(--summary-surface));
          }
          .summary:focus-visible {
            outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent);
            outline-offset: 2px;
          }
          .summary[aria-expanded="true"] { border-color: var(--dsw-alias-border-l3, var(--border)); }
          .summary svg { color: var(--muted); }
          .panel {
            position: absolute;
            z-index: 20;
            bottom: calc(100% + 7px);
            left: 12px;
            display: block;
            width: min(480px, calc(100vw - 24px));
            max-height: min(440px, 62vh);
            overflow: hidden auto;
            overscroll-behavior: contain;
            border: 1px solid var(--divider);
            border-radius: 16px;
            background: var(--panel-surface);
            box-shadow: var(--dsw-shadow-lv2, 0 10px 30px rgba(0,0,0,.12));
          }
          .panel[hidden] { display: none; }
          .row {
            display: grid;
            grid-template-columns: 24px minmax(0, 1fr) 28px;
            align-items: start;
            gap: 10px;
            min-height: 70px;
            padding: 14px 14px 14px 18px;
          }
          .row + .row { border-top: 1px solid var(--divider); }
          .number {
            color: var(--muted);
            font-size: 13px;
            line-height: 20px;
            text-align: left;
            user-select: none;
          }
          .copy { min-width: 0; }
          .field + .field { margin-top: 10px; }
          .field-label {
            color: var(--muted);
            font-size: 13px;
            line-height: 20px;
          }
          .quote,
          .note {
            overflow-wrap: anywhere;
            color: var(--dsw-alias-label-primary, inherit);
            font-size: 14px;
            line-height: 22px;
            white-space: pre-wrap;
          }
          .remove {
            display: grid;
            width: 28px;
            height: 28px;
            margin-top: -4px;
            place-items: center;
            border: 0;
            border-radius: 999px;
            background: transparent;
            color: var(--muted);
            font-size: 19px;
            opacity: 0;
            cursor: pointer;
            transition: opacity .12s ease, background-color .12s ease;
          }
          .row:hover .remove,
          .row:focus-within .remove { opacity: 1; }
          .remove:hover { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 10%, transparent)); }
          .remove:focus-visible {
            opacity: 1;
            outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent);
            outline-offset: 1px;
          }
          @media (max-width: 560px) {
            .panel {
              left: 8px;
              width: calc(100% - 16px);
              max-height: min(360px, 58vh);
            }
            .row { padding-inline: 14px 10px; }
          }
          @media (prefers-reduced-motion: reduce) {
            .summary,
            .remove { transition: none; }
          }
        </style>
        <div class="dock">
          <button class="summary" type="button" aria-expanded="false">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 2.7h7a2.7 2.7 0 0 1 2.7 2.7v3A2.7 2.7 0 0 1 10 11H7l-3.3 2 .7-2.4A2.7 2.7 0 0 1 2 8V5.4A2.7 2.7 0 0 1 3 2.7Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
            </svg>
            <span class="count">1 annotation</span>
          </button>
          <div class="panel" hidden></div>
        </div>
      `;

      const dockSummary = dockShadow.querySelector(".summary");
      const dockCount = dockShadow.querySelector(".count");
      const dockPanel = dockShadow.querySelector(".panel");
      let annotations = [];
      let nextAnnotationId = 1;
      let selected = null;
      let dockExpanded = false;
      let dockSignature = "";
      let toastTimer = 0;
      let prepared = null;
      let replayingSend = false;
      let applyingSourceMarks = false;

      function annotationLabel(count) {
        return `${count} 条注释`;
      }

      function liveRange(range) {
        try {
          return Boolean(
            range &&
              range.startContainer?.isConnected &&
              range.endContainer?.isConnected,
          );
        } catch (_) {
          return false;
        }
      }

      function resolveSourceRange(annotation, index) {
        if (liveRange(annotation.range)) return annotation.range;
        const root = sourceMessageRoot(annotation.sourceKey);
        const occurrence = annotations
          .slice(0, index)
          .filter(
            (row) =>
              row.sourceKey === annotation.sourceKey &&
              row.text === annotation.text,
          ).length;
        const range = root
          ? rangeFromExcerpt(root, annotation.text, occurrence)
          : null;
        if (range) annotation.range = range;
        return range;
      }

      function sourceMarksFor(id) {
        return Array.from(
          document.querySelectorAll(
            `[data-dsh-source-mark][data-dsh-annotation-id="${id}"]`,
          ),
        ).filter((mark) => !mark.closest("[data-dsh-add-to-chat]"));
      }

      function syncSourceMarks() {
        if (applyingSourceMarks) return;
        applyingSourceMarks = true;
        try {
          document.querySelectorAll("[data-dsh-source-mark]").forEach((mark) => {
            if (mark.closest("[data-dsh-add-to-chat]")) return;
            const id = Number(mark.dataset.dshAnnotationId);
            if (!annotations.some((annotation) => annotation.id === id)) {
              unwrapSourceMark(mark);
            }
          });
          annotations.forEach((annotation, index) => {
            const number = index + 1;
            const marks = sourceMarksFor(annotation.id);
            if (marks.length === 0) {
              const range = resolveSourceRange(annotation, index);
              if (range) {
                wrapRangeWithSourceMark(range, annotation.id, number);
                annotation.range = null;
              }
              return;
            }
            marks.forEach((mark, markIndex) => {
              let num = mark.querySelector("[data-dsh-source-num]");
              if (markIndex === marks.length - 1) {
                if (!num) {
                  num = document.createElement("span");
                  num.dataset.dshSourceNum = "";
                  mark.appendChild(num);
                }
                if (num.textContent !== String(number)) {
                  num.textContent = String(number);
                }
              } else if (num) {
                num.remove();
              }
            });
          });
        } finally {
          applyingSourceMarks = false;
        }
      }

      function closeTransient() {
        menu.dataset.open = "false";
        comment.dataset.open = "false";
        badge.dataset.open = "false";
        commentInput.value = "";
        selected = null;
        const active = shadow.activeElement;
        if (active && typeof active.blur === "function") active.blur();
      }

      function showToast() {
        window.clearTimeout(toastTimer);
        toast.dataset.open = "true";
        toastTimer = window.setTimeout(() => {
          toast.dataset.open = "false";
        }, 1600);
      }

      function clampPosition(element, left, top) {
        const margin = 10;
        return {
          left: Math.min(
            Math.max(margin, left),
            window.innerWidth - element.offsetWidth - margin,
          ),
          top: Math.min(
            Math.max(margin, top),
            window.innerHeight - element.offsetHeight - margin,
          ),
        };
      }

      function showMenu(details, x, y) {
        selected = details;
        comment.dataset.open = "false";
        badge.dataset.open = "false";
        menu.dataset.open = "true";
        requestAnimationFrame(() => {
          const originX = x || details.rect.left;
          const originY = y || details.rect.bottom;
          const position = clampPosition(menu, originX + 4, originY + 4);
          menu.style.left = `${position.left}px`;
          menu.style.top = `${position.top}px`;
          menuAction.focus({ preventScroll: true });
        });
      }

      function showComment() {
        if (!selected) return;
        menu.dataset.open = "false";
        badge.textContent = String(annotations.length + 1);
        badge.dataset.open = "true";
        comment.dataset.open = "true";
        requestAnimationFrame(() => {
          const rect = selected.rect;
          const preferredTop = rect.top - comment.offsetHeight - 14;
          const top = preferredTop >= 10 ? preferredTop : rect.bottom + 14;
          const position = clampPosition(
            comment,
            rect.left + rect.width / 2 - comment.offsetWidth / 2,
            top,
          );
          comment.style.left = `${position.left}px`;
          comment.style.top = `${position.top}px`;
          const badgePosition = clampPosition(
            badge,
            rect.right - badge.offsetWidth / 2,
            rect.top - badge.offsetHeight / 2,
          );
          badge.style.left = `${badgePosition.left}px`;
          badge.style.top = `${badgePosition.top}px`;
          commentInput.focus({ preventScroll: true });
        });
      }

      function attachDock() {
        const textarea = activeComposer();
        const card = textarea?.closest("[data-composer-card]");
        if (!card) return;
        if (dockHost.parentElement !== card) {
          const scroll = card.querySelector("[data-input-scroll]");
          card.insertBefore(dockHost, scroll || card.firstChild);
        }
      }

      function renderDock() {
        attachDock();
        dockHost.hidden = annotations.length === 0;
        if (annotations.length === 0) {
          dockExpanded = false;
          dockPanel.hidden = true;
        }
        const signature = JSON.stringify({
          rows: annotations.map(({ id, text, comment }) => ({
            id,
            text,
            comment,
          })),
          expanded: dockExpanded,
        });
        if (signature === dockSignature) return;
        dockSignature = signature;
        dockCount.textContent = annotationLabel(annotations.length);
        dockSummary.setAttribute("aria-expanded", String(dockExpanded));
        dockPanel.hidden = !dockExpanded;
        dockPanel.replaceChildren();
        annotations.forEach((annotation, index) => {
          const row = document.createElement("div");
          row.className = "row";
          const number = document.createElement("span");
          number.className = "number";
          number.textContent = `${index + 1}。`;
          const copy = document.createElement("div");
          copy.className = "copy";
          const quoteField = document.createElement("div");
          quoteField.className = "field";
          const quoteLabel = document.createElement("div");
          quoteLabel.className = "field-label";
          quoteLabel.textContent = "所选文本：";
          const quote = document.createElement("div");
          quote.className = "quote";
          quote.textContent = annotation.text;
          quote.title = annotation.text;
          quoteField.append(quoteLabel, quote);
          copy.appendChild(quoteField);
          if (annotation.comment) {
            const noteField = document.createElement("div");
            noteField.className = "field";
            const noteLabel = document.createElement("div");
            noteLabel.className = "field-label";
            noteLabel.textContent = "用户评论：";
            const note = document.createElement("div");
            note.className = "note";
            note.textContent = annotation.comment;
            noteField.append(noteLabel, note);
            copy.appendChild(noteField);
          }
          const remove = document.createElement("button");
          remove.className = "remove";
          remove.type = "button";
          remove.dataset.annotationId = String(annotation.id);
          remove.setAttribute("aria-label", "Remove annotation");
          remove.textContent = "×";
          row.append(number, copy, remove);
          dockPanel.appendChild(row);
        });
      }

      function ensureAnnotationOnlyDraft() {
        if (annotations.length === 0 || prepared) return;
        const textarea = activeComposer();
        if (!textarea || visibleDraft(textarea.value) !== "") return;
        if (textarea.value === SENTINEL) return;
        updateControlledTextarea(textarea, SENTINEL, false);
      }

      function removeAnnotation(id) {
        annotations = annotations.filter((annotation) => annotation.id !== id);
        dockSignature = "";
        renderDock();
        syncSourceMarks();
        const textarea = activeComposer();
        if (textarea && annotations.length === 0 && textarea.value === SENTINEL) {
          updateControlledTextarea(textarea, "");
        }
      }

      function commitAnnotation() {
        if (!selected) return;
        const id = nextAnnotationId++;
        const range = selected.range;
        annotations.push({
          id,
          text: selected.text,
          comment: commentInput.value.trim(),
          sourceKey: selected.sourceKey,
          range,
        });
        dockExpanded = false;
        window.getSelection()?.removeAllRanges();
        closeTransient();
        dockSignature = "";
        renderDock();
        syncSourceMarks();
        ensureAnnotationOnlyDraft();
        showToast();
      }

      function prepareAnnotationsForSend() {
        if (annotations.length === 0 || prepared) return false;
        const textarea = activeComposer();
        if (!textarea) return false;
        const snapshot = annotations.map((annotation) => ({ ...annotation }));
        const draft = visibleDraft(textarea.value);
        const wire = serializeAnnotations(snapshot, draft);
        prepared = {
          wire,
          draft,
          ids: snapshot.map((annotation) => annotation.id),
        };
        if (!updateControlledTextarea(textarea, wire, false)) {
          prepared = null;
          return false;
        }
        window.setTimeout(() => {
          if (!prepared || prepared.wire !== wire) return;
          const current = activeComposer();
          if (current?.value === wire) {
            updateControlledTextarea(current, draft || SENTINEL, false);
          }
          prepared = null;
        }, 2500);
        return true;
      }

      function isSendButton(button, card) {
        const label = [
          button.getAttribute("aria-label"),
          button.getAttribute("title"),
          button.textContent,
        ]
          .filter(Boolean)
          .join(" ");
        if (/发送消息|send message/i.test(label)) return true;
        if (button.type === "submit") return true;
        const buttons = Array.from(card.querySelectorAll("button"));
        return buttons.at(-1) === button;
      }

      function replaySend(textarea, preferredButton = null) {
        window.setTimeout(() => {
          const card = textarea.closest("[data-composer-card]");
          if (!card) return;
          const button =
            preferredButton?.isConnected && !preferredButton.disabled
              ? preferredButton
              : Array.from(card.querySelectorAll("button"))
                  .filter((candidate) => isSendButton(candidate, card))
                  .findLast((candidate) => !candidate.disabled);
          if (!button) return;
          replayingSend = true;
          try {
            button.click();
          } finally {
            replayingSend = false;
          }
        }, 0);
      }

      function userMessageTextBody(flow) {
        const imageSlot = flow.querySelector(
          '[data-slot="conversation.message.images"]',
        );
        const stack = imageSlot?.parentElement;
        if (!stack) return null;
        const bubble = Array.from(stack.children).find(
          (child) => child !== imageSlot && child instanceof HTMLElement,
        );
        return bubble?.firstElementChild || null;
      }

      function sentAnnotationView(parsed) {
        const root = document.createElement("div");
        root.dataset.dshSentAnnotations = "";
        const summary = document.createElement("button");
        summary.type = "button";
        summary.dataset.dshSentSummary = "";
        summary.setAttribute("aria-expanded", "false");
        summary.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 2.7h7a2.7 2.7 0 0 1 2.7 2.7v3A2.7 2.7 0 0 1 10 11H7l-3.3 2 .7-2.4A2.7 2.7 0 0 1 2 8V5.4A2.7 2.7 0 0 1 3 2.7Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
          </svg>
        `;
        const label = document.createElement("span");
        label.textContent = annotationLabel(parsed.annotations.length);
        summary.appendChild(label);
        const details = document.createElement("div");
        details.dataset.dshSentDetails = "";
        details.hidden = true;
        parsed.annotations.forEach((annotation) => {
          const row = document.createElement("div");
          const quote = document.createElement("div");
          quote.dataset.dshSentQuote = "";
          quote.textContent = annotation.text;
          row.appendChild(quote);
          if (annotation.comment) {
            const note = document.createElement("div");
            note.dataset.dshSentComment = "";
            note.textContent = annotation.comment;
            row.appendChild(note);
          }
          details.appendChild(row);
        });
        summary.addEventListener("click", () => {
          details.hidden = !details.hidden;
          summary.setAttribute("aria-expanded", String(!details.hidden));
        });
        root.append(summary, details);
        if (parsed.prompt) {
          const prompt = document.createElement("div");
          prompt.dataset.dshMessageMain = "";
          prompt.textContent = parsed.prompt;
          root.appendChild(prompt);
        }
        return root;
      }

      function decorateMessages() {
        document
          .querySelectorAll('[data-chat-flow-kind="user"]')
          .forEach((flow) => {
            const textBody = userMessageTextBody(flow);
            if (
              !textBody ||
              textBody.querySelector("[data-dsh-sent-annotations]")
            ) {
              return;
            }
            const raw = textBody.textContent || "";
            const parsed = parseWireMessage(raw) || parseLegacyQuote(raw);
            if (!parsed) return;
            textBody.replaceChildren(sentAnnotationView(parsed));
            if (!parsed.legacy && prepared) {
              const sentIds = new Set(parsed.annotations.map(({ id }) => id));
              if (prepared.ids.some((id) => sentIds.has(id))) {
                annotations = annotations.filter(({ id }) => !sentIds.has(id));
                prepared = null;
                dockSignature = "";
                renderDock();
                syncSourceMarks();
              }
            }
          });
      }

      let syncQueued = false;
      function scheduleSync() {
        if (syncQueued) return;
        syncQueued = true;
        requestAnimationFrame(() => {
          syncQueued = false;
          renderDock();
          decorateMessages();
          syncSourceMarks();
        });
      }

      menuAction.addEventListener("click", showComment);
      commentAction.addEventListener("click", commitAnnotation);
      commentInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          commitAnnotation();
        } else if (event.key === "Escape") {
          event.preventDefault();
          closeTransient();
        }
      });
      dockSummary.addEventListener("click", () => {
        dockExpanded = !dockExpanded;
        dockSignature = "";
        renderDock();
      });
      dockPanel.addEventListener("click", (event) => {
        const button =
          event.target instanceof Element
            ? event.target.closest("[data-annotation-id]")
            : null;
        if (button) removeAnnotation(Number(button.dataset.annotationId));
      });

      document.addEventListener("contextmenu", (event) => {
        if (event.composedPath().includes(overlayHost)) return;
        const details = selectionDetails();
        if (
          !details ||
          !pointTouchesSelection(details, event.clientX, event.clientY)
        ) {
          closeTransient();
          return;
        }
        event.preventDefault();
        showMenu(details, event.clientX, event.clientY);
      });
      document.addEventListener(
        "pointerdown",
        (event) => {
          const path = event.composedPath();
          if (!path.includes(overlayHost) && !path.includes(dockHost)) {
            closeTransient();
          }
        },
        true,
      );
      document.addEventListener(
        "input",
        (event) => {
          if (!(event.target instanceof HTMLTextAreaElement) || prepared) return;
          if (!event.target.matches(COMPOSER_SELECTOR)) return;
          window.setTimeout(ensureAnnotationOnlyDraft, 0);
        },
        true,
      );
      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Escape") closeTransient();
          if (
            !replayingSend &&
            event.target instanceof HTMLTextAreaElement &&
            event.target.matches(COMPOSER_SELECTOR) &&
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.isComposing
          ) {
            if (prepareAnnotationsForSend()) {
              event.preventDefault();
              event.stopImmediatePropagation();
              replaySend(event.target);
            }
          }
        },
        true,
      );
      document.addEventListener(
        "click",
        (event) => {
          if (replayingSend || !(event.target instanceof Element)) return;
          const button = event.target.closest("button");
          const card = button?.closest("[data-composer-card]");
          if (!button || !card || !isSendButton(button, card)) return;
          const textarea = card.querySelector("textarea");
          if (
            textarea instanceof HTMLTextAreaElement &&
            prepareAnnotationsForSend()
          ) {
            event.preventDefault();
            event.stopImmediatePropagation();
            replaySend(textarea, button);
          }
        },
        true,
      );
      window.addEventListener("scroll", closeTransient, true);
      window.addEventListener("resize", closeTransient);

      new MutationObserver(scheduleSync).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      scheduleSync();
    }

    //#endregion

    //#region feature: model-capabilities
    // The pi-ai adapter already understands per-model input modalities and
    // reasoningEfforts. Its settings card intentionally keeps those fields
    // hidden, so this feature decorates each expanded model row and folds the
    // extra values into the card's own settings.mutate transaction.
    const MODEL_CAPABILITIES_INSTALL_FLAG =
      "__dshAwesomeModelCapabilitiesInstalled";
    const MODEL_CAPABILITIES_ATTR = "data-dsh-model-capabilities";
    const MODEL_CAPABILITIES_STYLE_ATTR =
      "data-dsh-model-capabilities-style";
    const MODEL_ID_LABEL = /^(?:Model ID|模型 ID)\s+(\d+)$/i;
    const PROVIDER_SAVE_LABEL = /^(?:Save|Apply|Create|保存|应用|创建)$/i;
    const REASONING_LEVELS = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ];

    function getAtPath(source, path) {
      let value = source;
      for (const key of path) {
        if (typeof value !== "object" || value === null) return undefined;
        value = value[key];
      }
      return value;
    }

    function samePath(left, right) {
      return (
        left.length === right.length &&
        left.every((part, index) => part === right[index])
      );
    }

    function cloneJson(value) {
      return value === undefined ? undefined : structuredClone(value);
    }

    function modelIndexOf(input) {
      const match = MODEL_ID_LABEL.exec(input.getAttribute("aria-label") || "");
      return match ? Number(match[1]) - 1 : -1;
    }

    function modelEntryOf(input) {
      const row = input.parentElement;
      const entry = row?.parentElement;
      if (!row || !entry || row.querySelectorAll("input").length < 2) return null;
      return entry;
    }

    function advancedAreaOf(entry) {
      return Array.from(entry.children).find((child) => {
        if (!(child instanceof HTMLElement)) return false;
        return Array.from(child.querySelectorAll("input[aria-label]")).some(
          (input) =>
            /^(?:Context window|Model context window|上下文窗口)/i.test(
              input.getAttribute("aria-label") || "",
            ),
        );
      });
    }

    function editorOf(entry) {
      let current = entry.parentElement;
      while (current && current !== document.body) {
        const hasSave = Array.from(current.querySelectorAll("button")).some(
          (button) =>
            PROVIDER_SAVE_LABEL.test((button.textContent || "").trim()),
        );
        if (hasSave) return current;
        current = current.parentElement;
      }
      return null;
    }

    function fieldValue(editor, labels, selector = "input, select") {
      return Array.from(editor.querySelectorAll(`${selector}[aria-label]`)).find(
        (field) => labels.includes(field.getAttribute("aria-label") || ""),
      )?.value;
    }

    function installModelCapabilities(ctx) {
      if (window[MODEL_CAPABILITIES_INSTALL_FLAG]) return;
      const connection = ctx?.get?.("connection");
      const api = connection?.api;
      if (!api?.settings?.describe || !api?.settings?.mutate || !api?.llm?.providers) {
        console.warn(
          "[dsh-awsome-plugin] model capabilities require the connection service",
        );
        return;
      }
      window[MODEL_CAPABILITIES_INSTALL_FLAG] = true;

      const stateByHost = new WeakMap();
      const pendingEntries = new WeakSet();
      let providers = [];
      let namespaces = new Map();
      let sourcesLoadedAt = 0;
      let sourcePromise = null;
      let activeSave = null;
      let syncQueued = false;

      const style = document.createElement("style");
      style.setAttribute(MODEL_CAPABILITIES_STYLE_ATTR, "");
      style.textContent = `
        [${MODEL_CAPABILITIES_ATTR}] {
          grid-column: 1 / -1;
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 10px;
          padding-top: 4px;
        }
        [${MODEL_CAPABILITIES_ATTR}] .dsh-capability-field {
          display: flex;
          min-width: 0;
          flex-direction: column;
          gap: 4px;
        }
        [${MODEL_CAPABILITIES_ATTR}] .dsh-capability-label {
          color: var(--dsw-alias-label-tertiary);
          font-size: 12px;
          line-height: 18px;
        }
        [${MODEL_CAPABILITIES_ATTR}] .dsh-capability-select {
          box-sizing: border-box;
          width: 100%;
          height: 32px;
          padding: 0 30px 0 10px;
          color: var(--dsw-alias-label-primary);
          font: inherit;
          font-size: 13px;
          line-height: 20px;
          border: 1px solid var(--dsw-alias-border-l2);
          border-radius: 8px;
          background: var(--dsw-alias-bg-layer-1);
        }
        [${MODEL_CAPABILITIES_ATTR}] .dsh-capability-select:focus {
          border-color: var(--dsw-alias-brand-primary);
          outline: none;
        }
        [${MODEL_CAPABILITIES_ATTR}] .dsh-capability-efforts {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          padding-top: 2px;
        }
        [${MODEL_CAPABILITIES_ATTR}] .dsh-capability-efforts[hidden] {
          display: none;
        }
        [${MODEL_CAPABILITIES_ATTR}] .dsh-capability-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          min-height: 24px;
          padding: 0 7px;
          color: var(--dsw-alias-label-secondary);
          font-size: 11px;
          line-height: 16px;
          border: 1px solid var(--dsw-alias-border-l2);
          border-radius: 12px;
          cursor: pointer;
          user-select: none;
        }
        [${MODEL_CAPABILITIES_ATTR}] .dsh-capability-chip:has(input:checked) {
          color: var(--dsw-alias-brand-primary);
          border-color: var(--dsw-alias-brand-primary);
          background: var(--dsw-alias-interactive-bg-hover);
        }
        [${MODEL_CAPABILITIES_ATTR}] .dsh-capability-chip input {
          width: 12px;
          height: 12px;
          margin: 0;
          accent-color: var(--dsw-alias-brand-primary);
        }
        [${MODEL_CAPABILITIES_ATTR}] .dsh-capability-note {
          grid-column: 1 / -1;
          min-height: 16px;
          margin: -2px 0 0;
          color: var(--dsw-alias-label-dimmed);
          font-size: 11px;
          line-height: 16px;
        }
        [${MODEL_CAPABILITIES_ATTR}][data-dirty="true"] .dsh-capability-note {
          color: var(--dsw-alias-brand-primary);
        }
        [data-dsh-capability-toast] {
          position: fixed;
          right: 24px;
          bottom: 24px;
          z-index: 100000;
          max-width: min(420px, calc(100vw - 48px));
          padding: 10px 14px;
          color: var(--dsw-alias-label-primary-foreground);
          font-size: 13px;
          line-height: 20px;
          border-radius: 10px;
          background: var(--dsw-alias-brand-primary);
          box-shadow: 0 8px 30px rgba(0, 0, 0, .24);
        }
        [data-dsh-capability-toast][data-error="true"] {
          background: var(--dsw-alias-state-error-primary);
        }
      `;
      document.head.appendChild(style);

      let toastTimer = 0;
      function showToast(message, error = false) {
        let toast = document.querySelector("[data-dsh-capability-toast]");
        if (!toast) {
          toast = document.createElement("div");
          toast.dataset.dshCapabilityToast = "";
          toast.setAttribute("role", "status");
          toast.setAttribute("aria-live", "polite");
          document.body.appendChild(toast);
        }
        toast.dataset.error = String(error);
        toast.textContent = message;
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => toast.remove(), 2600);
      }

      async function refreshSources(force = false) {
        if (!force && Date.now() - sourcesLoadedAt < 1000) return true;
        if (sourcePromise) return sourcePromise;
        sourcePromise = Promise.all([
          api.llm.providers({}),
          api.settings.describe({}),
        ])
          .then(([providerResponse, settingsResponse]) => {
            if (!providerResponse.result.ok || !settingsResponse.result.ok) {
              return false;
            }
            providers = providerResponse.result.value.providers;
            namespaces = new Map(
              settingsResponse.result.value.namespaces.map((view) => [
                view.ns,
                view,
              ]),
            );
            sourcesLoadedAt = Date.now();
            return true;
          })
          .catch(() => false)
          .finally(() => {
            sourcePromise = null;
          });
        return sourcePromise;
      }

      function resolveTarget(editor) {
        const customRoute = fieldValue(editor, ["Provider ID"]);
        if (customRoute?.trim()) {
          return {
            provider: customRoute.trim(),
            settingsNs: "llm-pi-ai",
            settingsPath: ["providers", customRoute.trim()],
          };
        }

        const selectedProvider = fieldValue(
          editor,
          ["Provider", "提供方"],
          "select",
        );
        if (selectedProvider) {
          const found = providers.find(
            (entry) => entry.provider === selectedProvider,
          );
          if (found) return found;
        }

        const explicitRoute = editor.querySelector('[class*="_editorRoute"]')
          ?.textContent?.trim();
        if (explicitRoute) {
          const found = providers.find(
            (entry) => entry.provider === explicitRoute,
          );
          if (found) return found;
        }

        const rowName = editor
          .closest("li")
          ?.querySelector('[class*="_rowName"]')
          ?.textContent?.trim();
        const editorTitle = editor
          .querySelector('[class*="_editorTitle"]')
          ?.textContent?.trim();
        const identity = rowName || editorTitle;
        if (!identity) return null;
        return (
          providers.find(
            (entry) =>
              entry.displayName === identity || entry.provider === identity,
          ) || null
        );
      }

      function effectiveModels(target) {
        const namespace = namespaces.get(target.settingsNs);
        const profile = namespace
          ? getAtPath(namespace.value, target.settingsPath)
          : undefined;
        return Array.isArray(profile?.models)
          ? cloneJson(profile.models)
          : [];
      }

      function modelConfig(target, input) {
        const models = effectiveModels(target);
        const index = modelIndexOf(input);
        const id = input.value;
        return (
          (index >= 0 && models[index]?.id === id ? models[index] : undefined) ||
          models.find((model) => model?.id === id) ||
          {}
        );
      }

      function languageOf(input) {
        return (input.getAttribute("aria-label") || "").startsWith("模型")
          ? "zh"
          : "en";
      }

      function selectOption(value, text) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        return option;
      }

      function markDirty(host, state) {
        state.dirty = true;
        host.dataset.dirty = "true";
        state.note.textContent =
          state.language === "zh"
            ? "将随“保存”一起生效"
            : "Will be applied with Save";
      }

      async function ensureControls(input) {
        const entry = modelEntryOf(input);
        if (!entry || entry.querySelector(`[${MODEL_CAPABILITIES_ATTR}]`)) return;
        const advanced = advancedAreaOf(entry);
        const editor = advanced ? editorOf(entry) : null;
        if (!advanced || !editor || pendingEntries.has(entry)) return;
        pendingEntries.add(entry);
        try {
          if (!(await refreshSources())) return;
          if (!entry.isConnected) return;
          const target = resolveTarget(editor);
          if (!target || target.settingsNs !== "llm-pi-ai") return;

          const config = modelConfig(target, input);
          const language = languageOf(input);
          const copy =
            language === "zh"
              ? {
                  modalities: "多模态",
                  modalitiesAria: "是否支持多模态",
                  inherit: "跟随模型默认",
                  vision: "支持（文本 + 图片）",
                  textOnly: "不支持（仅文本）",
                  reasoning: "推理等级",
                  reasoningAria: "推理等级设置",
                  none: "不支持推理",
                  custom: "自定义支持等级",
                  developer: "系统提示词角色",
                  developerAria: "系统提示词角色",
                  developerSystem: "system（兼容网关）",
                  developerOpenAI: "developer（OpenAI）",
                  note: "模型能力将随此模型配置一起保存",
                }
              : {
                  modalities: "Multimodal",
                  modalitiesAria: "Multimodal support",
                  inherit: "Use model default",
                  vision: "Supported (text + image)",
                  textOnly: "Not supported (text only)",
                  reasoning: "Reasoning levels",
                  reasoningAria: "Reasoning level settings",
                  none: "No reasoning support",
                  custom: "Custom supported levels",
                  developer: "System prompt role",
                  developerAria: "System prompt role",
                  developerSystem: "system (gateway-safe)",
                  developerOpenAI: "developer (OpenAI)",
                  note: "Model capabilities are saved with this model",
                };

          const inputModalities = Array.isArray(config.input)
            ? config.input
            : [];
          const inputMode = inputModalities.includes("image")
            ? "vision"
            : inputModalities.includes("text")
              ? "text"
              : "inherit";
          const originalEfforts =
            typeof config.reasoningEfforts === "object" &&
            config.reasoningEfforts !== null
              ? cloneJson(config.reasoningEfforts)
              : {};
          const effortMode =
            config.reasoningEfforts === false
              ? "none"
              : Object.keys(originalEfforts).length > 0
                ? "custom"
                : "inherit";
          const efforts = new Set(
            REASONING_LEVELS.filter((level) => level in originalEfforts),
          );

          const host = document.createElement("div");
          host.setAttribute(MODEL_CAPABILITIES_ATTR, "");
          host.dataset.dirty = "false";

          const modalitiesField = document.createElement("label");
          modalitiesField.className = "dsh-capability-field";
          const modalitiesLabel = document.createElement("span");
          modalitiesLabel.className = "dsh-capability-label";
          modalitiesLabel.textContent = copy.modalities;
          const modalitiesSelect = document.createElement("select");
          modalitiesSelect.className = "dsh-capability-select";
          modalitiesSelect.setAttribute("aria-label", copy.modalitiesAria);
          modalitiesSelect.append(
            selectOption("inherit", copy.inherit),
            selectOption("vision", copy.vision),
            selectOption("text", copy.textOnly),
          );
          modalitiesSelect.value = inputMode;
          modalitiesField.append(modalitiesLabel, modalitiesSelect);

          const reasoningField = document.createElement("div");
          reasoningField.className = "dsh-capability-field";
          const reasoningLabel = document.createElement("span");
          reasoningLabel.className = "dsh-capability-label";
          reasoningLabel.textContent = copy.reasoning;
          const reasoningSelect = document.createElement("select");
          reasoningSelect.className = "dsh-capability-select";
          reasoningSelect.setAttribute("aria-label", copy.reasoningAria);
          reasoningSelect.append(
            selectOption("inherit", copy.inherit),
            selectOption("none", copy.none),
            selectOption("custom", copy.custom),
          );
          reasoningSelect.value = effortMode;
          const effortList = document.createElement("div");
          effortList.className = "dsh-capability-efforts";
          effortList.hidden = effortMode !== "custom";

          const effortInputs = new Map();
          REASONING_LEVELS.forEach((level) => {
            const label = document.createElement("label");
            label.className = "dsh-capability-chip";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.value = level;
            checkbox.checked = efforts.has(level);
            checkbox.setAttribute(
              "aria-label",
              `${copy.reasoning} ${level}`,
            );
            const text = document.createElement("span");
            text.textContent = level;
            label.append(checkbox, text);
            effortList.appendChild(label);
            effortInputs.set(level, checkbox);
          });
          reasoningField.append(reasoningLabel, reasoningSelect, effortList);

          const developerMode =
            config.compat?.supportsDeveloperRole === true
              ? "developer"
              : config.compat?.supportsDeveloperRole === false
                ? "system"
                : "inherit";
          const developerField = document.createElement("label");
          developerField.className = "dsh-capability-field";
          const developerLabel = document.createElement("span");
          developerLabel.className = "dsh-capability-label";
          developerLabel.textContent = copy.developer;
          const developerSelect = document.createElement("select");
          developerSelect.className = "dsh-capability-select";
          developerSelect.setAttribute("aria-label", copy.developerAria);
          developerSelect.append(
            selectOption("inherit", copy.inherit),
            selectOption("system", copy.developerSystem),
            selectOption("developer", copy.developerOpenAI),
          );
          developerSelect.value = developerMode;
          developerField.append(developerLabel, developerSelect);

          const note = document.createElement("p");
          note.className = "dsh-capability-note";
          note.textContent = copy.note;
          host.append(modalitiesField, reasoningField, developerField, note);
          advanced.appendChild(host);

          const state = {
            dirty: false,
            language,
            input,
            modalitiesSelect,
            reasoningSelect,
            developerSelect,
            effortList,
            effortInputs,
            originalEfforts,
            note,
          };
          stateByHost.set(host, state);

          modalitiesSelect.addEventListener("change", () => {
            markDirty(host, state);
          });
          reasoningSelect.addEventListener("change", () => {
            if (
              reasoningSelect.value === "custom" &&
              ![...effortInputs]
                .filter(([level]) => level !== "off")
                .some(([, checkbox]) => checkbox.checked)
            ) {
              ["low", "medium", "high"].forEach((level) => {
                effortInputs.get(level).checked = true;
              });
            }
            if (
              reasoningSelect.value === "custom" &&
              developerSelect.value === "inherit"
            ) {
              developerSelect.value = "system";
            }
            effortList.hidden = reasoningSelect.value !== "custom";
            markDirty(host, state);
          });
          developerSelect.addEventListener("change", () => {
            markDirty(host, state);
          });
          effortList.addEventListener("change", (event) => {
            const checkbox =
              event.target instanceof HTMLInputElement ? event.target : null;
            if (!checkbox) return;
            const hasThinkingLevel = [...effortInputs]
              .filter(([level]) => level !== "off")
              .some(([, input]) => input.checked);
            if (!hasThinkingLevel && checkbox.value !== "off") {
              checkbox.checked = true;
              showToast(
                language === "zh"
                  ? "自定义推理等级至少保留一个思考档位"
                  : "Keep at least one thinking level",
                true,
              );
              return;
            }
            markDirty(host, state);
          });
        } finally {
          pendingEntries.delete(entry);
        }
      }

      function capabilityDrafts(editor) {
        return Array.from(
          editor.querySelectorAll(`[${MODEL_CAPABILITIES_ATTR}]`),
        ).flatMap((host) => {
          const state = stateByHost.get(host);
          if (!state?.dirty) return [];
          return [
            {
              host,
              state,
              index: modelIndexOf(state.input),
              modelId: state.input.value,
              inputMode: state.modalitiesSelect.value,
              reasoningMode: state.reasoningSelect.value,
              developerRole: state.developerSelect.value,
              efforts: new Set(
                [...state.effortInputs]
                  .filter(([, checkbox]) => checkbox.checked)
                  .map(([level]) => level),
              ),
            },
          ];
        });
      }

      function applyCapabilityDraft(model, draft) {
        const next = { ...model };
        if (draft.inputMode === "inherit") delete next.input;
        else if (draft.inputMode === "vision") next.input = ["text", "image"];
        else next.input = ["text"];

        if (draft.reasoningMode === "inherit") {
          delete next.reasoningEfforts;
        } else if (draft.reasoningMode === "none") {
          next.reasoningEfforts = false;
        } else {
          next.reasoningEfforts = Object.fromEntries(
            REASONING_LEVELS.filter((level) => draft.efforts.has(level)).map(
              (level) => [
                level,
                Object.prototype.hasOwnProperty.call(
                  draft.state.originalEfforts,
                  level,
                )
                  ? draft.state.originalEfforts[level]
                  : level === "off"
                    ? null
                    : level,
              ],
            ),
          );
        }

        const compat = {
          ...(typeof next.compat === "object" && next.compat !== null
            ? next.compat
            : {}),
        };
        if (draft.developerRole === "developer") {
          compat.supportsDeveloperRole = true;
        } else if (
          draft.developerRole === "system" ||
          (draft.reasoningMode === "custom" &&
            draft.developerRole === "inherit")
        ) {
          // Unknown OpenAI-compatible gateways are detected as OpenAI: a
          // reasoning model then ships the system prompt as role "developer",
          // which GLM-class upstreams reject as 1214 角色信息不正确.
          compat.supportsDeveloperRole = false;
        } else {
          delete compat.supportsDeveloperRole;
        }
        if (Object.keys(compat).length === 0) delete next.compat;
        else next.compat = compat;
        return next;
      }

      function mergeModels(models, drafts) {
        const next = models.map((model) => ({ ...model }));
        let changed = false;
        drafts.forEach((draft) => {
          let index = draft.index;
          if (next[index]?.id !== draft.modelId) {
            index = next.findIndex((model) => model?.id === draft.modelId);
          }
          if (index < 0 || index >= next.length) return;
          next[index] = applyCapabilityDraft(next[index], draft);
          changed = true;
        });
        return { models: next, changed };
      }

      function mergeSaveRequest(request, save) {
        if (!save.target || request.ns !== save.target.settingsNs) {
          return { request, changed: false };
        }
        const modelsPath = [...save.target.settingsPath, "models"];
        let merged = false;
        const ops = request.ops.map((op) => {
          if (op.op !== "set") return op;
          if (samePath(op.path, modelsPath) && Array.isArray(op.value)) {
            const result = mergeModels(op.value, save.drafts);
            if (result.changed) merged = true;
            return result.changed ? { ...op, value: result.models } : op;
          }
          if (
            samePath(op.path, save.target.settingsPath) &&
            typeof op.value === "object" &&
            op.value !== null &&
            Array.isArray(op.value.models)
          ) {
            const result = mergeModels(op.value.models, save.drafts);
            if (result.changed) merged = true;
            return result.changed
              ? { ...op, value: { ...op.value, models: result.models } }
              : op;
          }
          return op;
        });

        if (!merged) {
          const result = mergeModels(effectiveModels(save.target), save.drafts);
          if (result.changed) {
            ops.push({ op: "set", path: modelsPath, value: result.models });
            merged = true;
          }
        }
        return {
          request: merged ? { ...request, ops } : request,
          changed: merged,
        };
      }

      function acceptNamespaceResponse(response) {
        if (!response?.result?.ok) return;
        const view = response.result.value;
        namespaces.set(view.ns, view);
        sourcesLoadedAt = Date.now();
      }

      function markSaveSettled(save) {
        save.drafts.forEach(({ host, state }) => {
          if (!host.isConnected) return;
          state.dirty = false;
          host.dataset.dirty = "false";
          state.note.textContent =
            state.language === "zh"
              ? "模型能力将随此模型配置一起保存"
              : "Model capabilities are saved with this model";
        });
      }

      const settingsFace = api.settings;
      const originalMutate = settingsFace.mutate.bind(settingsFace);
      const wrappedMutate = async (request, ...rest) => {
        const save = activeSave;
        const merged = save
          ? mergeSaveRequest(request, save)
          : { request, changed: false };
        if (save && merged.changed) save.handled = true;
        const response = await originalMutate(merged.request, ...rest);
        acceptNamespaceResponse(response);
        if (save && merged.changed && response.result.ok) markSaveSettled(save);
        return response;
      };
      let mutateWrapped = false;
      try {
        settingsFace.mutate = wrappedMutate;
        mutateWrapped = settingsFace.mutate === wrappedMutate;
      } catch (_) {
        mutateWrapped = false;
      }

      async function persistWithoutProviderWrite(save) {
        if (!save.target) {
          showToast(
            save.language === "zh"
              ? "无法确定当前提供方，模型能力未保存"
              : "Could not identify the provider; model capabilities were not saved",
            true,
          );
          return;
        }
        const namespace = namespaces.get(save.target.settingsNs);
        const baseRequest = {
          ns: save.target.settingsNs,
          ops: [],
          ...(namespace ? { expectedRevision: namespace.revision } : {}),
        };
        const merged = mergeSaveRequest(baseRequest, save);
        if (!merged.changed) {
          showToast(
            save.language === "zh"
              ? "没有可保存的模型能力配置"
              : "No model capability configuration could be saved",
            true,
          );
          return;
        }
        try {
          const response = await originalMutate(merged.request);
          acceptNamespaceResponse(response);
          if (!response.result.ok) {
            showToast(response.result.error.message, true);
            return;
          }
          markSaveSettled(save);
          showToast(
            save.language === "zh"
              ? "模型能力已保存"
              : "Model capabilities saved",
          );
        } catch (error) {
          showToast(error instanceof Error ? error.message : String(error), true);
        }
      }

      function onSaveCapture(event) {
        const button =
          event.target instanceof Element ? event.target.closest("button") : null;
        if (
          !button ||
          !PROVIDER_SAVE_LABEL.test((button.textContent || "").trim())
        ) {
          return;
        }
        let editor = button.parentElement;
        while (
          editor &&
          editor !== document.body &&
          editor.querySelector(`[${MODEL_CAPABILITIES_ATTR}][data-dirty="true"]`) ===
            null
        ) {
          editor = editor.parentElement;
        }
        if (!editor || editor === document.body) return;
        const drafts = capabilityDrafts(editor);
        if (drafts.length === 0) return;
        const save = {
          editor,
          drafts,
          target: resolveTarget(editor),
          language: drafts[0].state.language,
          handled: false,
        };
        activeSave = save;
        window.setTimeout(() => {
          if (activeSave === save) activeSave = null;
          if (!save.handled) persistWithoutProviderWrite(save);
        }, 0);
      }

      function scheduleSync() {
        if (syncQueued) return;
        syncQueued = true;
        requestAnimationFrame(() => {
          syncQueued = false;
          const inputs = Array.from(document.querySelectorAll("input[aria-label]"))
            .filter((input) => MODEL_ID_LABEL.test(input.getAttribute("aria-label") || ""));
          inputs.forEach((input) => ensureControls(input));
        });
      }

      document.addEventListener("click", onSaveCapture, true);
      const observer = new MutationObserver(scheduleSync);
      observer.observe(document.body, { childList: true, subtree: true });
      scheduleSync();

      return () => {
        observer.disconnect();
        document.removeEventListener("click", onSaveCapture, true);
        if (mutateWrapped && settingsFace.mutate === wrappedMutate) {
          settingsFace.mutate = originalMutate;
        }
        document
          .querySelectorAll(`[${MODEL_CAPABILITIES_ATTR}]`)
          .forEach((node) => node.remove());
        document.querySelector("[data-dsh-capability-toast]")?.remove();
        style.remove();
        window.clearTimeout(toastTimer);
        window[MODEL_CAPABILITIES_INSTALL_FLAG] = false;
      };
    }
    //#endregion


    //#region feature: archived-sessions-settings
    const SESSION_DELETE_ENDPOINT =
      "/_dsh-awsome-plugin/session.delete";
    const SESSION_UNARCHIVE_ENDPOINT =
      "/_dsh-awsome-plugin/session.unarchive";

    function dshLanguage(locale) {
      const active =
        locale?.getSnapshot?.()?.active ||
        locale?.getLocale?.()?.active ||
        document.documentElement.lang ||
        navigator.language ||
        "en";
      return String(active).toLowerCase().startsWith("zh") ? "zh" : "en";
    }

    function archivedSessionsLanguage(locale) {
      return dshLanguage(locale);
    }

    function showArchivedSessionsToast(message) {
      document.querySelector("[data-dsh-archived-toast]")?.remove();
      const toast = document.createElement("div");
      toast.dataset.dshArchivedToast = "";
      toast.setAttribute("role", "status");
      toast.textContent = message;
      document.body.appendChild(toast);
      window.setTimeout(() => toast.remove(), 2400);
    }

    function archivedSessionsCopy(locale) {
      if (archivedSessionsLanguage(locale) === "zh") {
        return {
          nav: "归档会话",
          title: "归档会话",
          subtitle: "归档只会从侧边栏隐藏会话；你可以在这里恢复，或手动永久清理本地数据。",
          search: "搜索归档会话",
          restore: "恢复",
          cleanup: "清理",
          cleanupAll: "清理全部",
          empty: "暂无归档会话",
          noResults: "没有匹配的归档会话",
          count: (count) => `${count} 个会话`,
          confirmTitle: "永久清理归档会话？",
          confirmSingle: (title) => `“${title}”的本地会话数据将被永久删除，无法恢复。`,
          confirmAll: (count) => `${count} 个归档会话的本地数据将被逐一永久删除，无法恢复。`,
          cancel: "取消",
          confirm: "永久清理",
          working: "正在清理…",
          cleaned: "归档会话已清理",
          restored: "会话已恢复",
          unknownWorkspace: "未分组",
          errors: {
            "session-running": "会话仍在运行，请先停止后再清理。",
            "session-not-owned": "该会话仍由旧的宿主进程持有。请重启 DSH 后再清理。",
            "session-still-live": "会话尚未完全卸载，请稍后重试。",
            "session-has-children": "该会话还有子会话，暂时无法安全清理。",
            "session-not-archived": "该会话已不在归档中，请刷新后重试。",
            "session-not-found": "本地会话不存在或已被清理。",
            "unsupported-persistence": "当前存储方式不支持清理，仅支持本地 JSONL 会话。",
            "unsupported-workspace-registry": "当前 DSH 版本不支持维护归档列表。",
            forbidden: "操作被宿主拒绝。",
            internal: "操作失败，请稍后重试。",
          },
        };
      }
      return {
        nav: "Archived chats",
        title: "Archived chats",
        subtitle:
          "Archiving only hides a chat from the sidebar. Restore it here or manually remove its local data.",
        search: "Search archived chats",
        restore: "Restore",
        cleanup: "Clean up",
        cleanupAll: "Clean up all",
        empty: "No archived chats",
        noResults: "No matching archived chats",
        count: (count) => `${count} chat${count === 1 ? "" : "s"}`,
        confirmTitle: "Permanently clean up archived chats?",
        confirmSingle: (title) =>
          `The local data for “${title}” will be permanently deleted. This cannot be undone.`,
        confirmAll: (count) =>
          `Local data for ${count} archived chat${count === 1 ? "" : "s"} will be permanently deleted one by one. This cannot be undone.`,
        cancel: "Cancel",
        confirm: "Delete permanently",
        working: "Cleaning up…",
        cleaned: "Archived chats cleaned up",
        restored: "Session restored",
        unknownWorkspace: "Ungrouped",
        errors: {
          "session-running": "Stop the running session before cleaning it up.",
          "session-not-owned": "An older host process still owns this session. Restart DSH and try again.",
          "session-still-live": "The session has not finished unloading. Try again shortly.",
          "session-has-children": "This session still has child sessions and cannot be safely cleaned up yet.",
          "session-not-archived": "This session is no longer archived. Refresh and try again.",
          "session-not-found": "The local session no longer exists.",
          "unsupported-persistence": "Cleanup currently supports local JSONL sessions only.",
          "unsupported-workspace-registry": "This DSH build cannot update the archive list.",
          forbidden: "The host rejected this action.",
          internal: "The action failed. Try again shortly.",
        },
      };
    }

    function archivedTrashIcon() {
      return React.createElement(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        React.createElement("path", {
          d: "M2.75 4.25h10.5M6 2.5h4M4.25 4.25l.55 8.25h6.4l.55-8.25M6.5 6.5v3.75M9.5 6.5v3.75",
          stroke: "currentColor",
          strokeWidth: 1.35,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }

    function installArchivedSessionsSettings(ctx) {
      const sessions = ctx?.sessions;
      const workspaces = ctx?.workspaces;
      const slots = ctx?.slots;
      const locale = ctx?.locale;
      if (!sessions?.list || !workspaces?.list || !slots?.inject) {
        console.warn(
          "[dsh-awsome-plugin] archived session settings require sessions, workspaces, and slots",
        );
        return;
      }

      const style = document.createElement("style");
      style.dataset.dshArchivedSessionsStyle = "";
      style.textContent = `
        [data-dsh-archived-sessions] { display:flex; width:100%; min-height:100%; flex-direction:column; color:var(--dsw-alias-label-primary); }
        [data-dsh-archived-sessions] * { box-sizing:border-box; }
        [data-dsh-archived-sessions] .dsh-archive-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:10px 0 20px; }
        [data-dsh-archived-sessions] h2 { margin:0; font-size:20px; font-weight:500; line-height:28px; }
        [data-dsh-archived-sessions] .dsh-archive-subtitle { max-width:500px; margin:5px 0 0; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; }
        [data-dsh-archived-sessions] button { font:inherit; }
        [data-dsh-archived-sessions] .dsh-archive-danger { display:inline-flex; height:32px; flex:none; align-items:center; gap:6px; padding:0 11px; color:var(--dsw-alias-state-error-primary,#d9363e); background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9363e) 10%,transparent); border:0; border-radius:9px; cursor:pointer; }
        [data-dsh-archived-sessions] .dsh-archive-danger:hover:not(:disabled) { background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9363e) 16%,transparent); }
        [data-dsh-archived-sessions] button:disabled { cursor:default; opacity:.5; }
        [data-dsh-archived-sessions] .dsh-archive-toolbar { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
        [data-dsh-archived-sessions] .dsh-archive-search { width:100%; height:36px; padding:0 12px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l2); border-radius:10px; outline:none; }
        [data-dsh-archived-sessions] .dsh-archive-search:focus { border-color:var(--dsw-alias-brand-primary); }
        [data-dsh-archived-sessions] .dsh-archive-count { flex:none; color:var(--dsw-alias-label-tertiary); font-size:12px; }
        [data-dsh-archived-sessions] .dsh-archive-error { margin:0 0 10px; padding:8px 10px; color:var(--dsw-alias-state-error-primary,#d9363e); background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9363e) 9%,transparent); border-radius:8px; font-size:12px; line-height:18px; }
        [data-dsh-archived-sessions] .dsh-archive-list { overflow:hidden; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; }
        [data-dsh-archived-sessions] .dsh-archive-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:14px; min-height:62px; padding:10px 12px; border-bottom:1px solid var(--dsw-alias-border-l3); }
        [data-dsh-archived-sessions] .dsh-archive-row:last-child { border-bottom:0; }
        [data-dsh-archived-sessions] .dsh-archive-title { overflow:hidden; font-size:13px; font-weight:500; line-height:20px; text-overflow:ellipsis; white-space:nowrap; }
        [data-dsh-archived-sessions] .dsh-archive-meta { overflow:hidden; margin-top:2px; color:var(--dsw-alias-label-tertiary); font-size:11px; line-height:17px; text-overflow:ellipsis; white-space:nowrap; }
        [data-dsh-archived-sessions] .dsh-archive-actions { display:flex; align-items:center; gap:7px; }
        [data-dsh-archived-sessions] .dsh-archive-restore { height:30px; padding:0 11px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-interactive-bg-hover); border:0; border-radius:8px; cursor:pointer; }
        [data-dsh-archived-sessions] .dsh-archive-icon { display:grid; width:30px; height:30px; place-items:center; padding:0; color:var(--dsw-alias-state-error-primary,#d9363e); background:transparent; border:0; border-radius:8px; cursor:pointer; }
        [data-dsh-archived-sessions] .dsh-archive-icon:hover:not(:disabled) { background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9363e) 10%,transparent); }
        [data-dsh-archived-sessions] .dsh-archive-empty { display:grid; min-height:180px; place-items:center; color:var(--dsw-alias-label-tertiary); font-size:13px; }
        [data-dsh-archived-sessions] .dsh-archive-confirm-layer { z-index:1300; display:grid; place-items:center; position:fixed; inset:0; padding:24px; background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45)); backdrop-filter:var(--dsw-mask-blur,blur(4px)); }
        [data-dsh-archived-sessions] .dsh-archive-confirm { width:min(400px,calc(100vw - 40px)); padding:20px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l2); border-radius:16px; box-shadow:var(--dsw-shadow-lv3); }
        [data-dsh-archived-sessions] .dsh-archive-confirm h3 { margin:0 0 8px; font-size:17px; line-height:24px; }
        [data-dsh-archived-sessions] .dsh-archive-confirm p { margin:0; color:var(--dsw-alias-label-secondary); font-size:13px; line-height:20px; }
        [data-dsh-archived-sessions] .dsh-archive-confirm-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
        [data-dsh-archived-sessions] .dsh-archive-confirm-actions button { min-width:74px; height:32px; padding:0 12px; border-radius:8px; cursor:pointer; }
        [data-dsh-archived-sessions] .dsh-archive-cancel { color:var(--dsw-alias-label-primary); background:transparent; border:1px solid var(--dsw-alias-border-l2); }
        [data-dsh-archived-sessions] .dsh-archive-confirm-delete { color:white; background:var(--dsw-alias-state-error-primary,#d9363e); border:0; }
        [data-dsh-archived-toast] { position:fixed; left:50%; bottom:24px; z-index:2147483647; transform:translateX(-50%); padding:9px 14px; color:var(--dsw-alias-label-primary-foreground,white); background:var(--dsw-alias-label-primary,#25262a); border-radius:10px; box-shadow:var(--dsw-shadow-lv3); font-size:13px; line-height:20px; pointer-events:none; }
      `;
      document.head.appendChild(style);
      ctx.effect?.(
        () => () => style.remove(),
        "dsh-awsome-plugin: archived sessions styles",
      );

      async function callArchiveMaintenance(endpoint, sessionId) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dsh-awsome-plugin-action": "archived-session-maintenance",
          },
          body: JSON.stringify({ sessionId }),
        });
        let payload;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (!response.ok || payload?.ok !== true) {
          const error = new Error(payload?.message || `request failed (${response.status})`);
          error.code = payload?.code || "internal";
          throw error;
        }
        return payload.value;
      }

      const h = React.createElement;
      function ArchivedSessionsSection() {
        React.useSyncExternalStore(
          (listener) =>
            typeof locale?.subscribe === "function"
              ? locale.subscribe(listener)
              : () => {},
          () =>
            locale?.getSnapshot?.()?.revision ??
            locale?.getSnapshot?.()?.active ??
            document.documentElement.lang,
        );
        const copy = archivedSessionsCopy(locale);
        const sessionState = React.useSyncExternalStore(
          (listener) => sessions.list.subscribe(listener),
          () => sessions.list.getSnapshot(),
        );
        const workspaceState = React.useSyncExternalStore(
          (listener) => workspaces.list.subscribe(listener),
          () => workspaces.list.getSnapshot(),
        );
        const [query, setQuery] = React.useState("");
        const [confirming, setConfirming] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [busyId, setBusyId] = React.useState(null);
        const [errorText, setErrorText] = React.useState("");

        React.useEffect(() => {
          sessions.refresh().catch(() => {});
          workspaces.refresh().catch(() => {});
        }, []);

        const archivedRows = workspaceState.archivedSessionIds.map((id) => {
          const summary = sessionState.byId[id];
          const workspace = workspaceState.items.find((item) =>
            item.sessionIds.includes(id),
          );
          return {
            id,
            title: summary?.displayTitle || id,
            updatedAt: summary?.updatedAt,
            workspace: workspace?.title || copy.unknownWorkspace,
          };
        });
        const needle = query.trim().toLocaleLowerCase();
        const visibleRows = needle
          ? archivedRows.filter((row) =>
              `${row.title}\n${row.workspace}\n${row.id}`
                .toLocaleLowerCase()
                .includes(needle),
            )
          : archivedRows;

        const describeError = (error) =>
          copy.errors[error?.code] || error?.message || copy.errors.internal;

        async function refreshLists() {
          await Promise.allSettled([sessions.refresh(), workspaces.refresh()]);
        }

        async function restore(row) {
          if (busy || busyId) return;
          setBusyId(row.id);
          setErrorText("");
          try {
            await callArchiveMaintenance(SESSION_UNARCHIVE_ENDPOINT, row.id);
            await refreshLists();
            showArchivedSessionsToast(copy.restored);
          } catch (error) {
            setErrorText(describeError(error));
          } finally {
            setBusyId(null);
          }
        }

        async function cleanConfirmed() {
          if (!confirming || busy) return;
          setBusy(true);
          setErrorText("");
          try {
            for (const id of confirming.ids) {
              try {
                await callArchiveMaintenance(SESSION_DELETE_ENDPOINT, id);
              } catch (error) {
                if (error?.code !== "session-not-found") throw error;
              }
            }
            setConfirming(null);
            await refreshLists();
            showArchivedSessionsToast(copy.cleaned);
          } catch (error) {
            setErrorText(describeError(error));
            setConfirming(null);
          } finally {
            setBusy(false);
          }
        }

        const rowNodes = visibleRows.map((row) => {
          const date =
            typeof row.updatedAt === "number"
              ? new Date(row.updatedAt).toLocaleString()
              : "";
          return h(
            "div",
            { className: "dsh-archive-row", key: row.id },
            h(
              "div",
              { className: "dsh-archive-main" },
              h("div", { className: "dsh-archive-title", title: row.title }, row.title),
              h(
                "div",
                { className: "dsh-archive-meta" },
                [row.workspace, date].filter(Boolean).join(" · "),
              ),
            ),
            h(
              "div",
              { className: "dsh-archive-actions" },
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-archive-restore",
                  disabled: busy || busyId !== null,
                  onClick: () => restore(row),
                },
                busyId === row.id ? "…" : copy.restore,
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-archive-icon",
                  "aria-label": `${copy.cleanup} ${row.title}`,
                  title: copy.cleanup,
                  disabled: busy || busyId !== null,
                  onClick: () => setConfirming({ ids: [row.id], title: row.title }),
                },
                archivedTrashIcon(),
              ),
            ),
          );
        });

        return h(
          "section",
          { "data-dsh-archived-sessions": "" },
          h(
            "div",
            { className: "dsh-archive-header" },
            h(
              "div",
              null,
              h("h2", null, copy.title),
              h("p", { className: "dsh-archive-subtitle" }, copy.subtitle),
            ),
            h(
              "button",
              {
                type: "button",
                className: "dsh-archive-danger",
                disabled: archivedRows.length === 0 || busy || busyId !== null,
                onClick: () =>
                  setConfirming({ ids: archivedRows.map((row) => row.id), title: null }),
              },
              archivedTrashIcon(),
              copy.cleanupAll,
            ),
          ),
          h(
            "div",
            { className: "dsh-archive-toolbar" },
            h("input", {
              className: "dsh-archive-search",
              type: "search",
              value: query,
              placeholder: copy.search,
              "aria-label": copy.search,
              onChange: (event) => setQuery(event.target.value),
            }),
            h("span", { className: "dsh-archive-count" }, copy.count(archivedRows.length)),
          ),
          errorText ? h("p", { className: "dsh-archive-error", role: "alert" }, errorText) : null,
          archivedRows.length === 0
            ? h("div", { className: "dsh-archive-empty" }, copy.empty)
            : visibleRows.length === 0
              ? h("div", { className: "dsh-archive-empty" }, copy.noResults)
              : h("div", { className: "dsh-archive-list" }, rowNodes),
          confirming
            ? h(
                "div",
                {
                  className: "dsh-archive-confirm-layer",
                  onMouseDown: (event) => {
                    if (event.target === event.currentTarget && !busy) setConfirming(null);
                  },
                },
                h(
                  "div",
                  {
                    className: "dsh-archive-confirm",
                    role: "alertdialog",
                    "aria-modal": true,
                  },
                  h("h3", null, copy.confirmTitle),
                  h(
                    "p",
                    null,
                    confirming.title
                      ? copy.confirmSingle(confirming.title)
                      : copy.confirmAll(confirming.ids.length),
                  ),
                  h(
                    "div",
                    { className: "dsh-archive-confirm-actions" },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "dsh-archive-cancel",
                        disabled: busy,
                        onClick: () => setConfirming(null),
                      },
                      copy.cancel,
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "dsh-archive-confirm-delete",
                        disabled: busy,
                        onClick: cleanConfirmed,
                      },
                      busy ? copy.working : copy.confirm,
                    ),
                  ),
                ),
              )
            : null,
        );
      }

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "archived-sessions",
            order: 60,
            label: () => archivedSessionsCopy(locale).nav,
          },
          ArchivedSessionsSection,
        ),
      );
    }
    //#endregion

    //#region feature: open-in-explorer
    const OPEN_IN_EXPLORER_ATTR = "data-dsh-open-in-explorer";
    const SESSION_ARCHIVE_MENU_LABEL = /^(归档会话|Archive session)$/;
    const SESSION_ACTIONS_ARIA =
      /(?:会话[“"「](.+)[”"」]的操作|^Session actions for (.+)$)/;

    function openInExplorerCopy(locale) {
      return dshLanguage(locale) === "zh"
        ? {
            label: "在资源管理器中打开",
            missing: "该会话没有工作目录",
            failed: "无法打开所在文件夹",
          }
        : {
            label: "Open in Explorer",
            missing: "This chat has no working directory",
            failed: "Could not open the folder",
          };
    }

    function installOpenInExplorer(ctx) {
      const sessions = ctx?.sessions;
      const workspaces = ctx?.workspaces;
      const locale = ctx?.locale;
      const api = ctx?.get?.("connection")?.api ?? ctx?.connection?.api;
      if (!sessions?.list) {
        console.warn(
          "[dsh-awsome-plugin] Open in Explorer requires the sessions service",
        );
        return;
      }

      let lastActionsButton = null;

      function showOpenToast(message) {
        document.querySelector("[data-dsh-open-in-explorer-toast]")?.remove();
        const toast = document.createElement("div");
        toast.dataset.dshOpenInExplorerToast = "";
        toast.setAttribute("role", "status");
        toast.textContent = message;
        toast.style.cssText =
          "position:fixed;left:50%;bottom:24px;z-index:2147483647;transform:translateX(-50%);padding:9px 14px;color:var(--dsw-alias-label-primary-foreground,white);background:var(--dsw-alias-label-primary,#25262a);border-radius:10px;font-size:13px;line-height:20px;pointer-events:none;";
        document.body.appendChild(toast);
        window.setTimeout(() => toast.remove(), 2400);
      }

      function sessionFromActionsButton(button) {
        const aria = button?.getAttribute("aria-label") || "";
        const match = SESSION_ACTIONS_ARIA.exec(aria);
        const title = match?.[1] || match?.[2];
        const snapshot = sessions.list.getSnapshot();
        const entries = Object.values(snapshot.byId || {});
        const matches = title
          ? entries.filter(
              (entry) =>
                entry.displayTitle === title || entry.title === title,
            )
          : [];
        if (matches.length === 1) return matches[0];
        if (snapshot.currentId) {
          const current = matches.find((entry) => entry.id === snapshot.currentId);
          if (current) return current;
        }
        return matches[0] || null;
      }

      async function openSessionFolder(session) {
        const copy = openInExplorerCopy(locale);
        const cwd = session?.cwd;
        if (!cwd) {
          showOpenToast(copy.missing);
          return;
        }
        try {
          if (typeof workspaces?.openPath === "function") {
            await workspaces.openPath(cwd);
            return;
          }
          const response = await api?.host?.openPath?.({ path: cwd });
          if (response?.result && response.result.ok === false) {
            throw new Error(response.result.error.message);
          }
        } catch (error) {
          showOpenToast(
            error instanceof Error ? error.message : copy.failed,
          );
        }
      }

      function isSessionActionsMenu(menu) {
        return Array.from(menu.querySelectorAll('[role="menuitem"], button')).some(
          (item) =>
            SESSION_ARCHIVE_MENU_LABEL.test((item.textContent || "").trim()),
        );
      }

      function decorateMenu(menu) {
        if (!(menu instanceof HTMLElement)) return;
        if (menu.querySelector(`[${OPEN_IN_EXPLORER_ATTR}]`)) return;
        if (!isSessionActionsMenu(menu)) return;

        const copy = openInExplorerCopy(locale);
        const sibling = Array.from(
          menu.querySelectorAll('[role="menuitem"], button'),
        ).find((item) =>
          SESSION_ARCHIVE_MENU_LABEL.test((item.textContent || "").trim()),
        );
        const item = document.createElement("button");
        item.type = "button";
        item.setAttribute("role", "menuitem");
        item.setAttribute(OPEN_IN_EXPLORER_ATTR, "");
        if (sibling?.className) item.className = sibling.className;
        item.setAttribute("aria-label", copy.label);

        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("width", "16");
        icon.setAttribute("height", "16");
        icon.setAttribute("viewBox", "0 0 16 16");
        icon.setAttribute("fill", "none");
        icon.setAttribute("aria-hidden", "true");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute(
          "d",
          "M2.5 4.75h4.1l1.15 1.4H13.5v6.1h-11V4.75Z",
        );
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", "1.35");
        path.setAttribute("stroke-linejoin", "round");
        icon.appendChild(path);

        const label = document.createElement("span");
        label.textContent = copy.label;
        item.append(icon, label);

        item.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const session = sessionFromActionsButton(lastActionsButton);
          menu.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
          );
          openSessionFolder(session);
        });
        menu.appendChild(item);
      }

      function onPointerDown(event) {
        const button =
          event.target instanceof Element
            ? event.target.closest("button")
            : null;
        if (!button) return;
        if (SESSION_ACTIONS_ARIA.test(button.getAttribute("aria-label") || "")) {
          lastActionsButton = button;
        }
      }

      function scheduleDecorate() {
        document.querySelectorAll('[role="menu"]').forEach(decorateMenu);
      }

      document.addEventListener("pointerdown", onPointerDown, true);
      const observer = new MutationObserver(scheduleDecorate);
      observer.observe(document.body, { childList: true, subtree: true });
      ctx.effect?.(
        () => () => {
          observer.disconnect();
          document.removeEventListener("pointerdown", onPointerDown, true);
          document
            .querySelectorAll(`[${OPEN_IN_EXPLORER_ATTR}]`)
            .forEach((node) => node.remove());
          document.querySelector("[data-dsh-open-in-explorer-toast]")?.remove();
        },
        "dsh-awsome-plugin: open in explorer",
      );
    }
    //#endregion

    //#region feature: system-fonts
    const FONT_STORAGE_KEY = "dsh-awsome-plugin:fonts";
    const FONT_STYLE_ATTR = "data-dsh-system-fonts-style";
    const FONT_APPLY_ATTR = "data-dsh-system-fonts-apply";
    const FONTS_ENDPOINT = "/_dsh-awsome-plugin/fonts";
    const DEFAULT_UI_STACK =
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif';
    const DEFAULT_CODE_STACK =
      '"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei"';
    const GENERIC_FONT_FAMILIES = new Set([
      "serif",
      "sans-serif",
      "monospace",
      "cursive",
      "fantasy",
      "system-ui",
      "ui-sans-serif",
      "ui-serif",
      "ui-monospace",
      "ui-rounded",
      "emoji",
      "math",
      "fangsong",
    ]);
    const FALLBACK_UI_FONTS = [
      "Segoe UI",
      "Microsoft YaHei",
      "Microsoft YaHei UI",
      "PingFang SC",
      "Hiragino Sans GB",
      "Source Han Sans SC",
      "Noto Sans SC",
      "Noto Sans CJK SC",
      "Microsoft JhengHei",
      "SimSun",
      "SimHei",
      "Arial",
      "Helvetica Neue",
      "Georgia",
      "Times New Roman",
      "system-ui",
    ];
    const FALLBACK_CODE_FONTS = [
      "Cascadia Code",
      "Cascadia Mono",
      "Consolas",
      "Courier New",
      "JetBrains Mono",
      "Fira Code",
      "SF Mono",
      "Menlo",
      "Source Code Pro",
      "Ubuntu Mono",
      "ui-monospace",
      "monospace",
    ];

    const FONT_SIZE_CHOICES = [80, 90, 100, 110, 120, 130, 150];

    function normalizeFontSize(value) {
      const size = Number(value);
      if (!Number.isFinite(size) || size === 0 || size === 100) return 0;
      return Math.min(200, Math.max(70, Math.round(size)));
    }

    function cssFontFamily(name) {
      if (!name) return "";
      if (GENERIC_FONT_FAMILIES.has(name.toLowerCase())) return name;
      if (/^[a-zA-Z][-a-zA-Z0-9]*$/.test(name)) return name;
      return `"${name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    }

    function readFontPreference() {
      try {
        const raw = window.localStorage.getItem(FONT_STORAGE_KEY);
        if (!raw) return { ui: "", code: "" };
        const parsed = JSON.parse(raw);
        return {
          ui: typeof parsed?.ui === "string" ? parsed.ui : "",
          code: typeof parsed?.code === "string" ? parsed.code : "",
          size: normalizeFontSize(parsed?.size),
        };
      } catch {
        return { ui: "", code: "", size: 0 };
      }
    }

    function writeFontPreference(preference) {
      window.localStorage.setItem(FONT_STORAGE_KEY, JSON.stringify(preference));
    }

    function fontApplySheet() {
      let sheet = document.querySelector(`style[${FONT_APPLY_ATTR}]`);
      if (!sheet) {
        sheet = document.createElement("style");
        sheet.setAttribute(FONT_APPLY_ATTR, "");
      }
      document.head.appendChild(sheet);
      return sheet;
    }

    function applyFontPreference(preference) {
      const sheet = fontApplySheet();
      const uiStack = preference.ui
        ? `${cssFontFamily(preference.ui)}, ${DEFAULT_UI_STACK}`
        : "";
      const codeStack = preference.code
        ? `${cssFontFamily(preference.code)}, ${DEFAULT_CODE_STACK}`
        : "";
      const size = normalizeFontSize(preference.size);
      if (!uiStack && !codeStack && !size) {
        sheet.textContent = "";
        return;
      }
      const lines = [];
      const vars = [
        uiStack ? `--dsw-font-family:${uiStack} !important` : "",
        codeStack ? `--ds-font-family-code:${codeStack} !important` : "",
      ].filter(Boolean);
      if (vars.length) lines.push(`html,body{${vars.join(";")}}`);
      if (uiStack) {
        lines.push(`html,body{font-family:${uiStack} !important}`);
        lines.push(
          `body *:not(code):not(pre):not(kbd):not(samp):not(tt){font-family:${uiStack} !important}`,
        );
      }
      if (codeStack) {
        lines.push(
          `body code,body pre,body kbd,body samp,body tt{font-family:${codeStack} !important}`,
        );
      }
      if (size) {
        const zoom = size / 100;
        lines.push(`html{zoom:unset}`);
        lines.push(
          `body>:not(:has([role="dialog"])):not(:has([role="menu"])):not([role="dialog"]):not([aria-modal="true"]){zoom:${zoom}}`,
        );
        lines.push(
          `[role="dialog"],[aria-modal="true"],[role="menu"],body>:has([role="dialog"]),body>:has([aria-modal="true"]),body>:has([role="menu"]){zoom:1}`,
        );
      }
      sheet.textContent = lines.join("");
    }

    async function callFontPreference(body) {
      const response = await fetch(FONTS_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dsh-awsome-plugin-action": "archived-session-maintenance",
        },
        body: JSON.stringify(body),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.message || `request failed (${response.status})`);
      }
      return payload.value;
    }

    function uniqueSortedFonts(names) {
      return [...new Set(names.filter(Boolean))].sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: "base" }),
      );
    }

    async function listInstalledFonts() {
      if (typeof window.queryLocalFonts === "function") {
        try {
          const fonts = await window.queryLocalFonts();
          const names = uniqueSortedFonts(fonts.map((font) => font.family));
          if (names.length > 0) return names;
        } catch (_) {}
      }
      const probe = uniqueSortedFonts(
        [...FALLBACK_UI_FONTS, ...FALLBACK_CODE_FONTS].filter((name) => {
          try {
            return document.fonts.check(`16px ${cssFontFamily(name)}`);
          } catch {
            return true;
          }
        }),
      );
      return probe.length > 0
        ? probe
        : uniqueSortedFonts([...FALLBACK_UI_FONTS, ...FALLBACK_CODE_FONTS]);
    }

    function systemFontsCopy(locale) {
      return dshLanguage(locale) === "zh"
        ? {
            title: "字体",
            subtitle: "选择本机已安装的字体和字号，立即作用于界面与代码。",
            ui: "界面字体",
            code: "代码字体",
            size: "字号",
            inherit: "跟随默认",
            sizeDefault: "默认 (100%)",
            sizeOption: (value) => `${value}%`,
          }
        : {
            title: "Fonts",
            subtitle: "Choose installed system fonts and size for the UI and code.",
            ui: "Interface font",
            code: "Code font",
            size: "Font size",
            inherit: "Use default",
            sizeDefault: "Default (100%)",
            sizeOption: (value) => `${value}%`,
          };
    }

    function installSystemFonts(ctx) {
      const slots = ctx?.slots;
      const locale = ctx?.locale;
      if (!slots?.inject) {
        console.warn(
          "[dsh-awsome-plugin] system fonts require the slots service",
        );
        return;
      }

      let preference = readFontPreference();
      applyFontPreference(preference);
      const preferenceListeners = new Set();
      const notifyPreference = () => {
        preferenceListeners.forEach((listener) => listener());
      };
      function adoptPreference(next) {
        preference = {
          ui: typeof next?.ui === "string" ? next.ui : "",
          code: typeof next?.code === "string" ? next.code : "",
          size: normalizeFontSize(next?.size),
        };
        writeFontPreference(preference);
        applyFontPreference(preference);
        notifyPreference();
      }

      let installedFonts = uniqueSortedFonts([
        ...FALLBACK_UI_FONTS,
        ...FALLBACK_CODE_FONTS,
        preference.ui,
        preference.code,
      ]);
      const fontListeners = new Set();
      const notifyFonts = () => {
        fontListeners.forEach((listener) => listener());
      };

      listInstalledFonts().then((names) => {
        installedFonts = uniqueSortedFonts([
          ...names,
          preference.ui,
          preference.code,
        ]);
        notifyFonts();
      });
      callFontPreference({ op: "get" })
        .then((value) => {
          adoptPreference(value);
          installedFonts = uniqueSortedFonts([
            ...installedFonts,
            preference.ui,
            preference.code,
          ]);
          notifyFonts();
        })
        .catch(() => {});

      const style = document.createElement("style");
      style.setAttribute(FONT_STYLE_ATTR, "");
      style.textContent = `
        [data-dsh-system-fonts] {
          border-bottom: 1px solid var(--dsw-alias-border-l2);
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 16px 0;
        }
        [data-dsh-system-fonts] .dsh-font-title {
          color: var(--dsw-alias-label-primary);
          font-size: 14px;
          font-weight: 400;
          line-height: 22px;
        }
        [data-dsh-system-fonts] .dsh-font-subtitle {
          color: var(--dsw-alias-label-tertiary);
          font-size: 12px;
          line-height: 18px;
        }
        [data-dsh-system-fonts] .dsh-font-fields {
          display: grid;
          gap: 10px;
        }
        [data-dsh-system-fonts] .dsh-font-field {
          display: flex;
          min-width: 0;
          flex-direction: column;
          gap: 4px;
        }
        [data-dsh-system-fonts] .dsh-font-label {
          color: var(--dsw-alias-label-secondary);
          font-size: 12px;
          line-height: 18px;
        }
        [data-dsh-system-fonts] .dsh-font-select {
          box-sizing: border-box;
          width: 100%;
          max-width: 360px;
          height: 36px;
          padding: 0 30px 0 14px;
          color: var(--dsw-alias-label-primary);
          font: inherit;
          font-size: 14px;
          line-height: 22px;
          border: none;
          border-radius: 18px;
          background: var(--dsw-alias-bg-module-platform);
          cursor: pointer;
        }
        [data-dsh-system-fonts] .dsh-font-select:hover {
          background: var(--dsw-alias-interactive-bg-hover);
        }
      `;
      document.head.appendChild(style);

      const h = React.createElement;
      function FontSettingsRow() {
        React.useSyncExternalStore(
          (listener) =>
            typeof locale?.subscribe === "function"
              ? locale.subscribe(listener)
              : () => {},
          () =>
            locale?.getSnapshot?.()?.revision ??
            locale?.getSnapshot?.()?.active ??
            document.documentElement.lang,
        );
        const fonts = React.useSyncExternalStore(
          (listener) => {
            fontListeners.add(listener);
            return () => fontListeners.delete(listener);
          },
          () => installedFonts,
        );
        const selected = React.useSyncExternalStore(
          (listener) => {
            preferenceListeners.add(listener);
            return () => preferenceListeners.delete(listener);
          },
          () => preference,
        );
        const ui = selected.ui;
        const code = selected.code;
        const size = selected.size || 0;
        const fontOptions = uniqueSortedFonts([...fonts, ui, code]);
        const copy = systemFontsCopy(locale);

        function commit(next) {
          adoptPreference(next);
          callFontPreference(next).catch(() => {});
        }

        return h(
          "div",
          { "data-dsh-system-fonts": "" },
          h("div", { className: "dsh-font-title" }, copy.title),
          h("div", { className: "dsh-font-subtitle" }, copy.subtitle),
          h(
            "div",
            { className: "dsh-font-fields" },
            h(
              "label",
              { className: "dsh-font-field" },
              h("span", { className: "dsh-font-label" }, copy.ui),
              h(
                "select",
                {
                  className: "dsh-font-select",
                  "aria-label": copy.ui,
                  value: ui,
                  style: ui ? { fontFamily: cssFontFamily(ui) } : undefined,
                  onChange: (event) => {
                    commit({ ui: event.target.value, code, size });
                  },
                },
                h("option", { value: "" }, copy.inherit),
                fontOptions.map((name) =>
                  h(
                    "option",
                    { key: `ui:${name}`, value: name, style: { fontFamily: cssFontFamily(name) } },
                    name,
                  ),
                ),
              ),
            ),
            h(
              "label",
              { className: "dsh-font-field" },
              h("span", { className: "dsh-font-label" }, copy.code),
              h(
                "select",
                {
                  className: "dsh-font-select",
                  "aria-label": copy.code,
                  value: code,
                  style: code ? { fontFamily: cssFontFamily(code) } : undefined,
                  onChange: (event) => {
                    commit({ ui, code: event.target.value, size });
                  },
                },
                h("option", { value: "" }, copy.inherit),
                fontOptions.map((name) =>
                  h(
                    "option",
                    { key: `code:${name}`, value: name, style: { fontFamily: cssFontFamily(name) } },
                    name,
                  ),
                ),
              ),
            ),
            h(
              "label",
              { className: "dsh-font-field" },
              h("span", { className: "dsh-font-label" }, copy.size),
              h(
                "select",
                {
                  className: "dsh-font-select",
                  "aria-label": copy.size,
                  value: size ? String(size) : "",
                  onChange: (event) => {
                    commit({
                      ui,
                      code,
                      size: normalizeFontSize(event.target.value),
                    });
                  },
                },
                h("option", { value: "" }, copy.sizeDefault),
                FONT_SIZE_CHOICES.filter((value) => value !== 100).map((value) =>
                  h(
                    "option",
                    { key: `size:${value}`, value: String(value) },
                    copy.sizeOption(value),
                  ),
                ),
              ),
            ),
          ),
        );
      }

      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          {
            name: "settings.general.item",
            id: "system-fonts",
            order: 20,
          },
          FontSettingsRow,
        ),
      );
      ctx.effect?.(
        () => () => {
          style.remove();
          document.querySelector(`style[${FONT_APPLY_ATTR}]`)?.remove();
          fontListeners.clear();
          preferenceListeners.clear();
        },
        "dsh-awsome-plugin: system fonts",
      );
    }
    //#endregion

    // Register the add-to-chat capability as the first feature of the plugin.
    // Future capabilities are added with additional registerFeature(...) calls.
    registerFeature({
      id: "add-to-chat",
      name: "Quick Reference",
      apply: installAddToChat,
    });
    registerFeature({
      id: "model-capabilities",
      name: "Model capabilities",
      apply: installModelCapabilities,
    });
    registerFeature({
      id: "archived-sessions-settings",
      name: "Archived chats",
      apply: installArchivedSessionsSettings,
    });
    registerFeature({
      id: "open-in-explorer",
      name: "Open in Explorer",
      apply: installOpenInExplorer,
    });
    registerFeature({
      id: "system-fonts",
      name: "System fonts",
      apply: installSystemFonts,
    });

    /** Cordis browser plugin body: mount every registered feature. */
    function apply(ctx) {
      function mountAll() {
        features.forEach((feature) => {
          try {
            feature.apply(ctx);
          } catch (error) {
            console.error(`[dsh-awsome-plugin] feature "${feature.id}" failed:`, error);
          }
        });
      }
      if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", mountAll, { once: true });
      } else {
        mountAll();
      }
    }
    //#endregion

    exports.apply = apply;
    exports.inject = ["connection", "sessions", "workspaces", "slots", "locale"];
    return module.exports;
  },
});
