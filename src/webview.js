(function () {
  "use strict";

  const INSTALL_FLAG = "__dshDesktopAddToChatInstalled";
  const CHAT_FLOW_SELECTOR = "[data-chat-flow]";
  const CHAT_ITEM_SELECTOR = "[data-chat-flow-key]";
  const COMPOSER_SELECTOR =
    "[data-composer-card] textarea, [data-composer-seat] textarea";
  const MAX_SELECTION_LENGTH = 6000;
  const SENTINEL = "\u2063";
  const WIRE_START = '<dsh_annotations version="1">\n';
  const WIRE_END = "\n</dsh_annotations>";

  function reportDocumentTitle() {
    try {
      void fetch(
        "http://dsh-shell.shell/api/console?msg=" +
          encodeURIComponent(document.title),
      ).catch(() => {});
    } catch (_) {
      // Diagnostics must never affect the Harness page.
    }
  }

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
    mark.querySelectorAll("[data-dsh-source-num]").forEach((node) => node.remove());
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
        background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 6%, transparent);
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
        background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 5%, transparent);
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
          --accent: var(--dsw-alias-state-business-primary, #0b84ff);
          --surface: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 88%, var(--dsw-alias-label-primary, #111) 12%);
          --text: var(--dsw-alias-label-primary, #171717);
          --muted: var(--dsw-alias-label-tertiary, #777);
          --border: var(--dsw-alias-border-l2, rgba(127,127,127,.22));
          color-scheme: light dark;
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
          box-shadow: 0 12px 36px rgba(0,0,0,.24);
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
          box-shadow: 0 12px 36px rgba(0,0,0,.22);
          pointer-events: auto;
        }
        .comment input {
          min-width: 0;
          flex: 1;
          border: 0;
          outline: 0;
          background: transparent;
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
          background: color-mix(in srgb, var(--text) 90%, transparent);
          color: var(--surface);
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
          <span>Add to chat</span>
        </button>
      </div>
      <div class="badge" aria-hidden="true">1</div>
      <div class="comment" role="dialog" aria-label="Add selected text to chat">
        <input type="text" placeholder="Add an optional comment…" aria-label="Optional comment">
        <button type="button" aria-label="Add to chat" title="Add to chat">
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
        :host { display: block; color: var(--dsw-alias-label-primary, inherit); }
        :host([hidden]) { display: none; }
        * { box-sizing: border-box; }
        .dock { padding: 0 12px 8px; font: 14px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; }
        .summary {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          min-height: 34px;
          padding: 0 12px;
          border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24));
          border-radius: 999px;
          background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 6%, transparent);
          color: inherit;
          font: inherit;
          font-weight: 600;
          cursor: pointer;
        }
        .summary svg { color: var(--dsw-alias-label-tertiary, #777); }
        .panel {
          display: grid;
          gap: 4px;
          margin-top: 7px;
          padding: 5px;
          border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.15));
          border-radius: 12px;
          background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 4%, transparent);
        }
        .panel[hidden] { display: none; }
        .row { display: grid; grid-template-columns: 24px minmax(0,1fr) 28px; align-items: center; gap: 8px; min-height: 42px; padding: 4px 5px; border-radius: 8px; }
        .number { display: grid; width: 22px; height: 22px; place-items: center; border-radius: 999px; background: var(--dsw-alias-state-business-primary, #0b84ff); color: white; font-size: 12px; font-weight: 700; }
        .copy { min-width: 0; }
        .quote { overflow: hidden; color: var(--dsw-alias-label-secondary, inherit); text-overflow: ellipsis; white-space: nowrap; }
        .note { overflow: hidden; margin-top: 2px; color: var(--dsw-alias-label-tertiary, #777); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
        .remove { display: grid; width: 28px; height: 28px; place-items: center; border: 0; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-tertiary, #777); font-size: 19px; cursor: pointer; }
        .remove:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
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
      return `${count} annotation${count === 1 ? "" : "s"}`;
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
            row.sourceKey === annotation.sourceKey && row.text === annotation.text,
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
        rows: annotations.map(({ id, text, comment }) => ({ id, text, comment })),
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
        number.textContent = String(index + 1);
        const copy = document.createElement("div");
        copy.className = "copy";
        const quote = document.createElement("div");
        quote.className = "quote";
        quote.textContent = annotation.text;
        quote.title = annotation.text;
        copy.appendChild(quote);
        if (annotation.comment) {
          const note = document.createElement("div");
          note.className = "note";
          note.textContent = annotation.comment;
          copy.appendChild(note);
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
      prepared = { wire, draft, ids: snapshot.map((annotation) => annotation.id) };
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
          if (!textBody || textBody.querySelector("[data-dsh-sent-annotations]")) {
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
      if (!details || !pointTouchesSelection(details, event.clientX, event.clientY)) {
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

  function boot() {
    reportDocumentTitle();
    installAddToChat();
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
