
const CARD_VERSION = "0.1.0";

const LOCALE_TAG = { en: "en", no: "nb-NO" };

const FALLBACK_REACTION_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;
const IMAGE_URL_PATTERN = /\.(?:jpe?g|png|gif|webp|svg)(?:[?#].*)?$/i;

const STRINGS = {
  en: {
    yesterday: "Yesterday",
    send: "Send",
    typeMessage: "Type a message…",
    noAccess: "No access to this chatroom.",
    noRooms: "No chatrooms available.",
    noMessages: "No messages yet.",
    readBy: "Read by",
  },
  no: {
    yesterday: "I går",
    send: "Send",
    typeMessage: "Skriv en melding…",
    noAccess: "Ingen tilgang til dette chatterommet.",
    noRooms: "Ingen chatterom tilgjengelig.",
    noMessages: "Ingen meldinger ennå.",
    readBy: "Lest av",
  },
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const _timeFormatters = new Map();
const _weekdayFormatters = new Map();
function timeFormatter(locale) {
  const key = locale || "";
  let f = _timeFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
    _timeFormatters.set(key, f);
  }
  return f;
}
function weekdayFormatter(locale) {
  const key = locale || "";
  let f = _weekdayFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { weekday: "long" });
    _weekdayFormatters.set(key, f);
  }
  return f;
}

function formatRelativeTime(iso, locale, lang) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const strings = STRINGS[lang] || STRINGS.en;
  const time = timeFormatter(locale).format(date);
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);

  if (diffDays === 0) return time;
  if (diffDays === 1) return `${strings.yesterday} ${time}`;
  const weekday = weekdayFormatter(locale).format(date);
  const capitalizedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${capitalizedWeekday} ${time}`;
}

class K93AnsChatCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._rooms = [];
    this._activeRoomId = null;
    this._messages = [];
    this._readStates = [];
    this._accessDenied = false;
    this._openPickerMessageId = null;
    this._reactionEmoji = FALLBACK_REACTION_EMOJI;
    this._pendingImage = null;
    this._unsubscribeRoom = null;
    this._built = false;
    this._lastMessagesHtml = null;
    this._lastRoomPickerHtml = null;
    this._onVisibilityChange = () => this._maybeMarkRead();
  }

  setConfig(config) {
    this._config = {
      chatroom_id: "",
      language: "auto",
      message_limit: 50,
      card_height: null,
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    const firstAssignment = !this._hass;
    this._hass = hass;
    if (firstAssignment) {
      this._init();
    }
  }

  _lang() {
    const configured = this._config?.language;
    if (configured && configured !== "auto") return configured;
    const hassLang = this._hass?.language || "";
    return /^n[bno]/i.test(hassLang) ? "no" : "en";
  }

  _str(key) {
    const strings = STRINGS[this._lang()] || STRINGS.en;
    return strings[key] || key;
  }

  getCardSize() {
    const cfg = this._config;
    if (cfg?.card_height) return Math.max(1, Math.round(cfg.card_height / 50));
    return 6;
  }

  getGridOptions() {
    const cfg = this._config;
    if (!cfg?.card_height) return undefined;
    const rows = Math.max(1, Math.round((Number(cfg.card_height) + 8) / 64));
    return { rows };
  }

  connectedCallback() {
    if (!this._clockInterval) {
      this._clockInterval = setInterval(() => this._refreshRelativeTimestamps(), 30000);
    }
    document.addEventListener("visibilitychange", this._onVisibilityChange);
    if (this._activeRoomId && this._hass) {
      this._fetchMessages(this._activeRoomId);
      if (!this._unsubscribeRoom) this._subscribeRoom(this._activeRoomId);
    }
    this._maybeMarkRead();
  }

  disconnectedCallback() {
    if (this._clockInterval) {
      clearInterval(this._clockInterval);
      this._clockInterval = null;
    }
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
    if (this._unsubscribeRoom) {
      this._unsubscribeRoom();
      this._unsubscribeRoom = null;
    }
  }

  async _init() {
    if (this._config.chatroom_id) {
      await this._selectRoom(this._config.chatroom_id);
    } else {
      await this._fetchRooms();
      if (this._rooms.length) {
        await this._selectRoom(this._rooms[0].id);
      }
    }
  }

  async _fetchRooms() {
    try {
      const result = await this._hass.callWS({ type: "k93_ans/chat/list_rooms" });
      this._rooms = result.chatrooms || [];
      if (result.reaction_emoji && result.reaction_emoji.length) {
        this._reactionEmoji = result.reaction_emoji;
      }
    } catch (err) {
      console.error("k93-ans-chat-card: failed to list chatrooms", err);
      this._rooms = [];
    }
    this._render();
  }

  async _selectRoom(chatroomId) {
    if (this._unsubscribeRoom) {
      this._unsubscribeRoom();
      this._unsubscribeRoom = null;
    }
    this._activeRoomId = chatroomId;
    this._messages = [];
    this._readStates = [];
    this._accessDenied = false;
    this._forceScrollToBottom = true;
    this._render();
    await this._fetchMessages(chatroomId);
    await this._subscribeRoom(chatroomId);
    this._maybeMarkRead();
  }

  async _fetchMessages(chatroomId) {
    try {
      const result = await this._hass.callWS({
        type: "k93_ans/chat/list_messages",
        chatroom_id: chatroomId,
        limit: Number(this._config.message_limit) || 50,
      });
      this._messages = (result.messages || []).slice().reverse();
      this._readStates = result.read_states || [];
      if (result.reaction_emoji && result.reaction_emoji.length) {
        this._reactionEmoji = result.reaction_emoji;
      }
      this._accessDenied = false;
    } catch (err) {
      this._messages = [];
      this._readStates = [];
      this._accessDenied = Boolean(err && err.code === "access_denied");
      if (!this._accessDenied) {
        console.error("k93-ans-chat-card: failed to load messages", err);
      }
    }
    this._render();
  }

  async _subscribeRoom(chatroomId) {
    try {
      this._unsubscribeRoom = await this._hass.connection.subscribeMessage(
        (msg) => {
          if (msg.message) this._onMessage(msg.message);
          if (msg.read) this._onRead(msg.read);
          if (msg.reaction) this._onReaction(msg.reaction);
        },
        { type: "k93_ans/chat/subscribe", chatroom_id: chatroomId }
      );
    } catch (err) {
      console.error("k93-ans-chat-card: failed to subscribe", err);
    }
  }

  _onMessage(message) {
    if (message.chatroom_id !== this._activeRoomId) return;
    if (this._messages.some((m) => m.id === message.id)) return;
    this._messages = [...this._messages, message];
    this._forceScrollToBottom = true;
    this._render();
    this._maybeMarkRead();
    if (!this._config.chatroom_id) this._fetchRooms();
  }

  _onRead(read) {
    const now = new Date().toISOString();
    const idx = this._readStates.findIndex((r) => r.user_id === read.user_id);
    if (idx >= 0) {
      this._readStates = [
        ...this._readStates.slice(0, idx),
        { ...this._readStates[idx], last_read_at: now },
        ...this._readStates.slice(idx + 1),
      ];
    } else {
      this._readStates = [...this._readStates, { user_id: read.user_id, last_read_at: now }];
    }
    this._render();
  }

  _onReaction(payload) {
    const idx = this._messages.findIndex((m) => m.id === payload.message_id);
    if (idx < 0) return;
    this._messages = [
      ...this._messages.slice(0, idx),
      { ...this._messages[idx], reactions: payload.reactions },
      ...this._messages.slice(idx + 1),
    ];
    this._render();
  }

  async _toggleReaction(messageId, emoji) {
    if (!this._activeRoomId || !messageId || !emoji) return;
    try {
      await this._hass.callWS({
        type: "k93_ans/chat/toggle_reaction",
        chatroom_id: this._activeRoomId,
        message_id: messageId,
        emoji,
      });
    } catch (err) {
      console.error("k93-ans-chat-card: failed to toggle reaction", err);
    }
  }

  _maybeMarkRead() {
    if (!this._activeRoomId || !this._hass || !this.isConnected) return;
    if (document.visibilityState !== "visible") return;
    this._hass
      .callWS({ type: "k93_ans/chat/mark_read", chatroom_id: this._activeRoomId })
      .catch((err) => console.error("k93-ans-chat-card: failed marking read", err));
  }

  async _sendMessage() {
    const input = this._inputEl;
    if (!input || !this._activeRoomId) return;
    const text = input.value.trim();
    const pending = this._pendingImage;
    if (!text && !pending) return;
    input.value = "";
    this._autosizeInput();
    this._pendingImage = null;
    this._renderComposerPreview();
    try {
      const payload = { type: "k93_ans/chat/send", chatroom_id: this._activeRoomId, message: text };
      if (pending) {
        payload.image_base64 = pending.base64;
        payload.image_content_type = pending.contentType;
      }
      await this._hass.callWS(payload);
    } catch (err) {
      console.error("k93-ans-chat-card: failed to send message", err);
    } finally {
      if (pending?.previewUrl) URL.revokeObjectURL(pending.previewUrl);
    }
  }

  async _resizeImageFile(file, maxDim = 1280, quality = 0.82) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    const base64 = await this._blobToBase64(blob);
    return { base64, contentType: "image/jpeg", previewUrl: URL.createObjectURL(blob) };
  }

  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = String(reader.result || "");
        const commaIdx = result.indexOf(",");
        resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async _onFileSelected(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const resized = await this._resizeImageFile(file);
      if (this._pendingImage?.previewUrl) URL.revokeObjectURL(this._pendingImage.previewUrl);
      this._pendingImage = resized;
      this._renderComposerPreview();
    } catch (err) {
      console.error("k93-ans-chat-card: failed to process image", err);
    }
  }

  _clearPendingImage() {
    if (this._pendingImage?.previewUrl) URL.revokeObjectURL(this._pendingImage.previewUrl);
    this._pendingImage = null;
    this._renderComposerPreview();
  }

  _renderComposerPreview() {
    if (!this._composerPreviewEl) return;
    if (!this._pendingImage) {
      this._composerPreviewEl.hidden = true;
      this._composerPreviewEl.innerHTML = "";
      return;
    }
    this._composerPreviewEl.hidden = false;
    this._composerPreviewEl.innerHTML =
      `<img src="${esc(this._pendingImage.previewUrl)}" alt="" />` +
      `<button type="button" class="composer-preview-remove" aria-label="Remove image">×</button>`;
  }

  _autosizeInput() {
    const input = this._inputEl;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }

  _refreshRelativeTimestamps() {
    if (!this._messagesEl) return;
    const timeEls = this._messagesEl.querySelectorAll(".time[data-created]");
    if (!timeEls.length) return;
    const lang = this._lang();
    const locale = LOCALE_TAG[lang] || undefined;
    for (const el of timeEls) {
      const label = formatRelativeTime(el.dataset.created, locale, lang);
      if (el.textContent !== label) el.textContent = label;
    }
  }

  _initials(name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return "?";
    const parts = trimmed.split(/\s+/);
    const first = parts[0][0] || "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase() || "?";
  }

  _colorForSender(key) {
    const str = String(key || "");
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    return `hsl(${hash % 360}, 55%, 45%)`;
  }

  _avatarHtml(sender, senderKey) {
    if (sender.picture) {
      return `<img class="avatar" src="${esc(sender.picture)}" alt="" />`;
    }
    if (sender.icon) {
      return (
        `<span class="avatar avatar-icon" style="background:${esc(this._colorForSender(senderKey))};">` +
        `<ha-icon icon="${esc(sender.icon)}"></ha-icon></span>`
      );
    }
    return (
      `<span class="avatar avatar-initials" style="background:${esc(this._colorForSender(senderKey))};">` +
      `${esc(this._initials(sender.name))}</span>`
    );
  }

  _computeReadByMap() {
    const map = new Map();
    for (const r of this._readStates || []) {
      if (!r.last_read_at) continue;
      let target = null;
      for (const m of this._messages) {
        if (m.sender_user_id === r.user_id) continue;
        if (m.created > r.last_read_at) break;
        target = m;
      }
      if (target) {
        if (!map.has(target.id)) map.set(target.id, []);
        map.get(target.id).push(r.name);
      }
    }
    return map;
  }

  _captionHtml(message, locale, lang, readByMap) {
    const readers = readByMap.get(message.id) || [];
    const timeHtml = `<span class="time" data-created="${esc(message.created)}">${esc(formatRelativeTime(message.created, locale, lang))}</span>`;
    const readByHtml = readers.length
      ? `${esc(this._str("readBy"))} ${esc(readers.join(", "))} - `
      : "";
    return `<div class="message-caption">${readByHtml}${timeHtml}</div>`;
  }

  _reactionsHtml(message) {
    const reactions = message.reactions || [];
    if (!reactions.length) return "";
    const myId = this._hass?.user?.id;
    const pills = reactions
      .map((r) => {
        const mine = myId && r.user_ids.includes(myId) ? " mine" : "";
        return (
          `<button type="button" class="reaction-pill${mine}" data-toggle-emoji="${esc(r.emoji)}" data-message-id="${esc(message.id)}">` +
          `${esc(r.emoji)}<span class="reaction-count">${r.count}</span></button>`
        );
      })
      .join("");
    return `<div class="reactions">${pills}</div>`;
  }

  _reactionCornerHtml(message) {
    const picker =
      this._openPickerMessageId === message.id
        ? `<div class="reaction-picker">${this._reactionEmoji.map(
            (emoji) =>
              `<button type="button" data-picker-emoji="${esc(emoji)}" data-message-id="${esc(message.id)}">${esc(emoji)}</button>`
          ).join("")}</div>`
        : "";
    return (
      `<div class="reaction-corner">` +
      `<button type="button" class="add-reaction" data-add-reaction="${esc(message.id)}" aria-label="Add reaction">+</button>` +
      `${picker}</div>`
    );
  }

  _messageImageHtml(message) {
    if (!message.image) return "";
    return (
      `<a href="${esc(message.image)}" target="_blank" rel="noopener noreferrer">` +
      `<img class="message-image" src="${esc(message.image)}" alt="" /></a>`
    );
  }

  _urlPreviewHtml(text) {
    const match = String(text || "").match(URL_PATTERN);
    if (!match) return "";
    let hostname;
    try {
      hostname = new URL(match[0]).hostname;
    } catch (err) {
      return "";
    }
    if (IMAGE_URL_PATTERN.test(match[0])) {
      return (
        `<a class="link-preview link-preview-image" href="${esc(match[0])}" target="_blank" rel="noopener noreferrer">` +
        `<img src="${esc(match[0])}" alt="" /></a>`
      );
    }
    return (
      `<a class="link-preview" href="${esc(match[0])}" target="_blank" rel="noopener noreferrer">` +
      `<ha-icon icon="mdi:link-variant"></ha-icon><span>${esc(hostname)}</span></a>`
    );
  }

  _messageHtml(message, locale, lang, readByMap) {
    const sender = message.sender || {};
    const senderKey = message.sender_user_id || sender.name || "";
    const isOwn = Boolean(this._hass?.user && message.sender_user_id === this._hass.user.id);
    const textHtml = message.message ? `<div class="text">${esc(message.message)}</div>` : "";
    return (
      `<div class="message${isOwn ? " own" : ""}">` +
      this._avatarHtml(sender, senderKey) +
      `<div class="bubble-column">` +
      `<div class="bubble">` +
      `<div class="meta"><span class="sender-name">${esc(sender.name || "")}</span></div>` +
      this._messageImageHtml(message) +
      textHtml +
      this._urlPreviewHtml(message.message) +
      this._reactionsHtml(message) +
      this._reactionCornerHtml(message) +
      `</div>` +
      this._captionHtml(message, locale, lang, readByMap) +
      `</div></div>`
    );
  }

  _buildMessagesHtml() {
    if (this._accessDenied) {
      return `<div class="empty-state">${esc(this._str("noAccess"))}</div>`;
    }
    if (!this._activeRoomId) {
      return `<div class="empty-state">${esc(this._str("noRooms"))}</div>`;
    }
    if (!this._messages.length) {
      return `<div class="empty-state">${esc(this._str("noMessages"))}</div>`;
    }
    const lang = this._lang();
    const locale = LOCALE_TAG[lang] || undefined;
    const readByMap = this._computeReadByMap();
    return this._messages.map((m) => this._messageHtml(m, locale, lang, readByMap)).join("");
  }

  _isScrolledNearBottom() {
    const el = this._messagesEl;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  _renderMessages() {
    const html = this._buildMessagesHtml();
    if (html === this._lastMessagesHtml) return;
    const shouldScroll = this._forceScrollToBottom || this._isScrolledNearBottom();
    this._lastMessagesHtml = html;
    this._messagesEl.innerHTML = html;
    if (shouldScroll) {
      this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
    }
    this._forceScrollToBottom = false;
  }

  _renderRoomPicker() {
    const cfg = this._config;
    let html;
    if (cfg.chatroom_id) {
      const room = this._rooms.find((r) => r.id === cfg.chatroom_id);
      html = room
        ? `<div class="room-header">${room.icon ? `<ha-icon icon="${esc(room.icon)}"></ha-icon>` : ""}<span>${esc(room.name)}</span></div>`
        : "";
    } else if (!this._rooms.length) {
      html = `<div class="room-header empty">${esc(this._str("noRooms"))}</div>`;
    } else {
      html = `<div class="room-chips">${this._rooms
        .map((room) => {
          const active = room.id === this._activeRoomId ? " active" : "";
          const badge =
            room.unread_count > 0
              ? `<span class="unread-badge">${room.unread_count > 9 ? "9+" : room.unread_count}</span>`
              : "";
          return (
            `<button type="button" class="room-chip${active}" data-room-id="${esc(room.id)}">` +
            (room.icon ? `<ha-icon icon="${esc(room.icon)}"></ha-icon>` : "") +
            `<span>${esc(room.name)}</span>${badge}</button>`
          );
        })
        .join("")}</div>`;
    }
    if (html === this._lastRoomPickerHtml) return;
    this._lastRoomPickerHtml = html;
    this._roomPickerEl.innerHTML = html;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;

    if (!this._built) {
      this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          display: flex;
          flex-direction: column;
          overflow: hidden;
          height: 100%;
          max-height: 85vh;
        }
        .room-picker {
          flex: 0 0 auto;
          border-bottom: 1px solid var(--divider-color);
        }
        .room-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px;
          font-weight: 500;
        }
        .room-header.empty {
          color: var(--secondary-text-color);
          font-weight: normal;
        }
        .room-chips {
          display: flex;
          gap: 6px;
          padding: 8px 12px;
          overflow-x: auto;
        }
        .room-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border: 1px solid var(--divider-color);
          background: transparent;
          color: var(--primary-text-color);
          border-radius: 999px;
          padding: 5px 12px;
          font: inherit;
          font-size: 0.9em;
          cursor: pointer;
          flex-shrink: 0;
        }
        .room-chip.active {
          background: color-mix(in srgb, var(--primary-color, #0a84ff) 18%, transparent);
          border-color: var(--primary-color, #0a84ff);
        }
        .unread-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 16px;
          height: 16px;
          padding: 0 4px;
          border-radius: 999px;
          background: var(--error-color, #ff453a);
          color: #fff;
          font-size: 0.7em;
          font-weight: bold;
        }
        .messages {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          scrollbar-width: thin;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .empty-state {
          margin: auto;
          color: var(--secondary-text-color);
          font-size: 0.95em;
          text-align: center;
        }
        .message {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          max-width: 85%;
        }
        .message.own {
          flex-direction: row-reverse;
          align-self: flex-end;
        }
        .avatar {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          object-fit: cover;
          flex-shrink: 0;
        }
        .avatar-initials,
        .avatar-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: #fff;
          font-size: 0.75em;
          font-weight: bold;
          --mdc-icon-size: 18px;
        }
        .bubble-column {
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 0;
        }
        .message.own .bubble-column {
          align-items: flex-end;
        }
        .bubble {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 2px;
          background: var(--secondary-background-color, rgba(127, 127, 127, 0.12));
          border-radius: 12px;
          padding: 6px 10px;
          min-width: 0;
        }
        .message.own .bubble {
          background: color-mix(in srgb, var(--primary-color, #0a84ff) 22%, transparent);
          align-items: flex-end;
          text-align: right;
        }
        .meta {
          display: flex;
          align-items: baseline;
          gap: 6px;
          font-size: 0.75em;
          color: var(--secondary-text-color);
        }
        .sender-name {
          font-weight: 600;
        }
        .text {
          white-space: pre-wrap;
          word-break: break-word;
          font-size: 0.95em;
        }
        .message-image {
          display: block;
          max-width: 220px;
          max-height: 220px;
          border-radius: 8px;
          object-fit: cover;
        }
        .link-preview {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 10px;
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          color: var(--primary-text-color);
          text-decoration: none;
          font-size: 0.85em;
          max-width: 220px;
        }
        .link-preview span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .link-preview-image {
          display: block;
          padding: 0;
          border: none;
          max-width: 220px;
        }
        .link-preview-image img {
          display: block;
          max-width: 220px;
          max-height: 220px;
          border-radius: 8px;
          object-fit: cover;
        }
        .message-caption {
          font-size: 0.7em;
          color: var(--secondary-text-color);
          opacity: 0.8;
          padding: 0 4px;
        }
        .reactions {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 4px;
          margin-top: 2px;
        }
        .reaction-pill {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          border: 1px solid var(--divider-color);
          background: transparent;
          border-radius: 999px;
          padding: 1px 7px;
          font-size: 0.85em;
          line-height: 1.7;
          cursor: pointer;
        }
        .reaction-pill.mine {
          border-color: var(--primary-color, #0a84ff);
          background: color-mix(in srgb, var(--primary-color, #0a84ff) 16%, transparent);
        }
        .reaction-count {
          font-size: 0.85em;
          color: var(--secondary-text-color);
        }
        .reaction-corner {
          position: absolute;
          bottom: -8px;
          left: -8px;
        }
        .add-reaction {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 20px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color, var(--secondary-background-color, #fff));
          color: var(--secondary-text-color);
          border-radius: 999px;
          cursor: pointer;
          font-size: 0.85em;
          line-height: 1;
          padding: 0;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        }
        .reaction-picker {
          position: absolute;
          bottom: 100%;
          left: 0;
          margin-bottom: 6px;
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          padding: 4px 6px;
          max-width: 180px;
          border: 1px solid var(--divider-color);
          border-radius: 10px;
          background: var(--card-background-color, var(--secondary-background-color, #fff));
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
        }
        .reaction-picker button {
          border: none;
          background: transparent;
          font-size: 1.1em;
          line-height: 1;
          cursor: pointer;
          padding: 3px 4px;
          border-radius: 6px;
        }
        .composer {
          flex: 0 0 auto;
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 8px 12px;
          border-top: 1px solid var(--divider-color);
        }
        .composer-preview {
          position: relative;
          width: fit-content;
        }
        .composer-preview img {
          display: block;
          max-height: 80px;
          max-width: 120px;
          border-radius: 8px;
          object-fit: cover;
        }
        .composer-preview-remove {
          position: absolute;
          top: -6px;
          right: -6px;
          width: 20px;
          height: 20px;
          border-radius: 999px;
          border: none;
          background: var(--error-color, #ff453a);
          color: #fff;
          cursor: pointer;
          line-height: 1;
          font-size: 0.9em;
          padding: 0;
        }
        .composer-row {
          display: flex;
          align-items: flex-end;
          gap: 8px;
        }
        .composer-attach {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          border: 1px solid var(--divider-color);
          border-radius: 10px;
          background: transparent;
          color: var(--secondary-text-color);
          cursor: pointer;
        }
        .composer-input {
          flex: 1 1 auto;
          resize: none;
          min-height: 20px;
          max-height: 120px;
          font: inherit;
          color: var(--primary-text-color);
          background: var(--secondary-background-color, rgba(127, 127, 127, 0.08));
          border: 1px solid var(--divider-color);
          border-radius: 10px;
          padding: 8px 10px;
        }
        .composer-send {
          flex-shrink: 0;
          border: none;
          border-radius: 10px;
          padding: 8px 14px;
          background: var(--primary-color, #0a84ff);
          color: #fff;
          font: inherit;
          font-weight: 600;
          cursor: pointer;
        }
        .composer-send:disabled {
          opacity: 0.5;
          cursor: default;
        }
      </style>
      <ha-card>
        <div class="room-picker"></div>
        <div class="messages"></div>
        <div class="composer">
          <div class="composer-preview" hidden></div>
          <div class="composer-row">
            <button type="button" class="composer-attach" aria-label="Attach image">
              <ha-icon icon="mdi:image-plus"></ha-icon>
            </button>
            <input type="file" accept="image/*" class="composer-file-input" hidden />
            <textarea class="composer-input" rows="1"></textarea>
            <button type="button" class="composer-send"></button>
          </div>
        </div>
      </ha-card>
      `;
      this._built = true;
      this._cardEl = this.shadowRoot.querySelector("ha-card");
      this._roomPickerEl = this.shadowRoot.querySelector(".room-picker");
      this._messagesEl = this.shadowRoot.querySelector(".messages");
      this._inputEl = this.shadowRoot.querySelector(".composer-input");
      this._sendBtnEl = this.shadowRoot.querySelector(".composer-send");
      this._composerPreviewEl = this.shadowRoot.querySelector(".composer-preview");
      this._attachBtnEl = this.shadowRoot.querySelector(".composer-attach");
      this._fileInputEl = this.shadowRoot.querySelector(".composer-file-input");

      this._sendBtnEl.addEventListener("click", () => this._sendMessage());
      this._attachBtnEl.addEventListener("click", () => this._fileInputEl.click());
      this._fileInputEl.addEventListener("change", (ev) => this._onFileSelected(ev));
      this._composerPreviewEl.addEventListener("click", (ev) => {
        if (ev.target.closest(".composer-preview-remove")) this._clearPendingImage();
      });
      this._inputEl.addEventListener("input", () => this._autosizeInput());
      this._inputEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          this._sendMessage();
        }
      });
      this._roomPickerEl.addEventListener("click", (ev) => {
        const chip = ev.target.closest("[data-room-id]");
        if (chip) this._selectRoom(chip.dataset.roomId);
      });
      this._messagesEl.addEventListener("click", (ev) => {
        const pill = ev.target.closest("[data-toggle-emoji]");
        if (pill) {
          this._toggleReaction(pill.dataset.messageId, pill.dataset.toggleEmoji);
          return;
        }
        const pickerChoice = ev.target.closest("[data-picker-emoji]");
        if (pickerChoice) {
          this._toggleReaction(pickerChoice.dataset.messageId, pickerChoice.dataset.pickerEmoji);
          this._openPickerMessageId = null;
          this._renderMessages();
          return;
        }
        const addBtn = ev.target.closest("[data-add-reaction]");
        if (addBtn) {
          const id = addBtn.dataset.addReaction;
          this._openPickerMessageId = this._openPickerMessageId === id ? null : id;
          this._renderMessages();
          return;
        }
        if (this._openPickerMessageId) {
          this._openPickerMessageId = null;
          this._renderMessages();
        }
      });
    }

    const cfg = this._config;
    if (cfg.card_height) {
      this._cardEl.style.height = `${Number(cfg.card_height)}px`;
      this._cardEl.style.maxHeight = "none";
    } else {
      this._cardEl.style.removeProperty("height");
      this._cardEl.style.removeProperty("max-height");
    }
    this._inputEl.placeholder = this._str("typeMessage");
    this._sendBtnEl.textContent = this._str("send");
    this._sendBtnEl.disabled = !this._activeRoomId;

    this._renderRoomPicker();
    this._renderMessages();
  }

  static getStubConfig() {
    return {
      chatroom_id: "",
      language: "auto",
      message_limit: 50,
      card_height: null,
    };
  }

  static getConfigElement() {
    return document.createElement("k93-ans-chat-card-editor");
  }
}

class K93AnsChatCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._updateForm();
  }

  set hass(hass) {
    this._hass = hass;
    this._updateForm();
  }

  connectedCallback() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (item) => K93AnsChatCardEditor.LABELS[item.name] || item.name;
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: this._config },
            bubbles: true,
            composed: true,
          })
        );
      });
      this.appendChild(this._form);

      const versionEl = document.createElement("div");
      versionEl.textContent = `K93 ANS Chat Card v${CARD_VERSION}`;
      versionEl.style.cssText =
        "text-align: right; font-size: 0.75em; opacity: 0.5; padding: 4px 2px 0;";
      this.appendChild(versionEl);
    }
    this._updateForm();
  }

  _chatroomOptions() {
    const hass = this._hass;
    if (hass) {
      const cached = this._chatSensorId && hass.states[this._chatSensorId];
      const chatrooms = cached
        ? cached.attributes.chatrooms
        : (() => {
            for (const stateObj of Object.values(hass.states)) {
              if (
                stateObj.entity_id.startsWith("sensor.k93_ans") &&
                Array.isArray(stateObj.attributes?.chatrooms)
              ) {
                this._chatSensorId = stateObj.entity_id;
                return stateObj.attributes.chatrooms;
              }
            }
            return null;
          })();
      if (Array.isArray(chatrooms)) {
        return chatrooms.map((room) => ({
          value: room.id,
          label: room.enabled === false ? `${room.name} (disabled)` : room.name,
        }));
      }
    }
    return [];
  }

  _schema() {
    return [
      {
        name: "group_room",
        type: "expandable",
        title: "Chatroom",
        expanded: true,
        flatten: true,
        schema: [
          {
            name: "chatroom_id",
            selector: {
              select: {
                options: [{ value: "", label: "(let the viewer choose)" }, ...this._chatroomOptions()],
              },
            },
          },
          {
            name: "language",
            selector: {
              select: {
                options: [
                  { value: "auto", label: "Automatic (match Home Assistant)" },
                  { value: "en", label: "English" },
                  { value: "no", label: "Norsk" },
                ],
              },
            },
          },
          {
            name: "message_limit",
            selector: { number: { min: 1, max: 500, mode: "box" } },
          },
        ],
      },
      {
        name: "group_appearance",
        type: "expandable",
        title: "Card appearance",
        expanded: true,
        flatten: true,
        schema: [
          {
            name: "card_height",
            selector: { number: { min: 100, max: 1000, step: 10, mode: "box", unit_of_measurement: "px" } },
          },
        ],
      },
    ];
  }

  _updateForm() {
    if (!this._form || !this._config) return;
    this._form.hass = this._hass;
    const schema = this._schema();
    const schemaJson = JSON.stringify(schema);
    if (schemaJson !== this._schemaJson) {
      this._schemaJson = schemaJson;
      this._form.schema = schema;
    }
    this._form.data = this._config;
  }
}

K93AnsChatCardEditor.LABELS = {
  group_room: "Chatroom",
  group_appearance: "Card appearance",
  chatroom_id: "Chatroom (blank = let the viewer choose, if they have access to more than one)",
  language: "Language",
  message_limit: "Messages to load",
  card_height: "Card height (px, blank = fill the dashboard cell)",
};

customElements.define("k93-ans-chat-card", K93AnsChatCard);
customElements.define("k93-ans-chat-card-editor", K93AnsChatCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "k93-ans-chat-card",
  name: "K93 ANS Chat Card",
  description: "A chatroom card for the k93_ans integration - sender avatars, read receipts, and sending new messages.",
});
