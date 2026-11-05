const tg = window.Telegram?.WebApp;
const $ = (id) => document.getElementById(id);
const state = { chats: [], projects: [], selected: null, detail: null, tab: "messages", polling: false, writing: false, drafts: new Map(), rendered: {}, edit: null };
let toastTimer;
function updateViewport() {
  // Telegram reports its content area, already excluding the native app header.
  // visualViewport also follows the keyboard when the host's update arrives later.
  const visual = window.visualViewport;
  const visibleHeight = visual && visual.scale === 1 ? visual.height : window.innerHeight;
  const height = tg?.viewportHeight > 0 ? Math.min(tg.viewportHeight, visibleHeight) : visibleHeight;
  document.documentElement.style.setProperty("--app-viewport-height", `${Math.round(height)}px`);
}
tg?.onEvent("viewportChanged", updateViewport);
window.addEventListener("resize", updateViewport);
window.visualViewport?.addEventListener("resize", updateViewport);
updateViewport();
tg?.ready();
tg?.expand();
tg?.onEvent("themeChanged", () => { document.documentElement.style.colorScheme = tg.colorScheme; });
if (tg?.colorScheme) document.documentElement.style.colorScheme = tg.colorScheme;

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function button(text, className, action, label) {
  const el = node("button", className, text);
  el.type = "button";
  if (label) { el.setAttribute("aria-label", label); el.title = label; }
  el.addEventListener("click", action);
  return el;
}
function toast(text, error = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = text;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, error ? 10000 : 4000);
}
function connection(text, kind = "") {
  $("connection").textContent = "";
  $("connection").className = `connection ${kind}`;
  $("connection").setAttribute("aria-label", text);
  $("connection").title = text;
}
function showFilters(open) {
  $("filters").hidden = !open;
  $("filters-toggle").setAttribute("aria-expanded", String(open));
}
async function api(path, method = "GET", body, requestKey, raw = false) {
  const headers = { Authorization: `tma ${tg.initData}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (requestKey) headers["Idempotency-Key"] = requestKey;
  const response = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35000), cache: "no-store" });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) {
      connection("Войдите снова", "error");
    }
    throw new Error(result.error || `Ошибка ${response.status}`);
  }
  return raw ? response.blob() : response.json();
}
function chatPath(id = state.selected) { return `/chats/${encodeURIComponent(id)}`; }
function queuePath(item) { return item.native ? `${chatPath()}/queue/${encodeURIComponent(item.id)}` : `/queue/${item.id}`; }
function draft() {
  if (!state.drafts.has(state.selected)) state.drafts.set(state.selected, { text: "", key: crypto.randomUUID() });
  return state.drafts.get(state.selected);
}
function sizePrompt() {
  const prompt = $("prompt");
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 120)}px`;
}
function status(chat) {
  if (chat.activeTurn?.state === "waiting_approval") return "Нужно подтверждение в чате бота";
  if (chat.activeTurn) return "Codex работает…";
  if (chat.status === "active") return "Выполняется в Codex App";
  return "Готов к работе";
}
function projectName(id) { return state.projects.find((project) => project.id === id)?.alias || "Проект"; }
function title(chat) { return chat.title || chat.preview?.slice(0, 80) || "Новый чат"; }
function renderList() {
  const project = $("project").value;
  const query = $("search").value.trim().toLocaleLowerCase();
  const chats = state.chats.filter((chat) => (!project || String(chat.projectId) === project) && `${title(chat)} ${chat.preview || ""} ${projectName(chat.projectId)}`.toLocaleLowerCase().includes(query));
  $("chat-count").textContent = String(chats.length);
  $("new-chat").disabled = state.writing;
  $("filters-toggle").classList.toggle("filtered", !!(project || query));
  const rows = chats.map((chat) => {
    const row = node("div", `chat-row${chat.id === state.selected ? " selected" : ""}`);
    const open = button("", "chat-open", () => openChat(chat.id));
    const text = node("span", "chat-text");
    text.append(node("span", "chat-name", title(chat)), node("span", "chat-preview", chat.preview || "Начните с первого сообщения"));
    const meta = node("span", "chat-meta");
    meta.append(node("span", "", projectName(chat.projectId)));
    if (chat.activeTurn || chat.status === "active") meta.append(node("span", "running", "● работает"));
    if (chat.queued) meta.append(node("span", "", `в очереди: ${chat.queued}`));
    if (chat.unread) meta.append(node("span", "unread", String(chat.unread)));
    text.append(meta); open.append(text);
    const favorite = button(chat.favorite ? "★" : "☆", `favorite${chat.favorite ? " on" : ""}`, () => write(() => api(`${chatPath(chat.id)}/favorite`, "POST", {})), chat.favorite ? "Убрать из избранного" : "В избранное");
    row.append(open, favorite);
    return row;
  });
  $("chats").replaceChildren(...(rows.length ? rows : [node("p", "empty", query ? "По этому запросу чатов нет." : "Пока нет чатов. Выберите проект и нажмите ＋.")]));
}
function renderMessages(detail) {
  const signature = JSON.stringify(detail.messages);
  if (state.rendered.messages === signature) return;
  const container = $("messages");
  const atBottom = !state.rendered.messages || container.scrollHeight - container.scrollTop - container.clientHeight < 100;
  const rows = detail.messages.map((message, index) => {
    const row = node("article", `message ${message.role}`);
    const label = node("div", "message-label");
    label.textContent = message.role === "user" ? "Вы" : "Codex";
    const content = node("div", "message-text");
    if (typeof message.html === "string") {
      // Only the server's allowlist-sanitized Markdown goes through this sink.
      content.classList.add("markdown"); content.innerHTML = message.html;
    } else content.textContent = message.text;
    row.append(label, content);
    const lastInTurn = detail.messages[index + 1]?.turnId !== message.turnId;
    if (lastInTurn && ["failed", "interrupted"].includes(message.status)) row.append(node("div", "message-state", message.status === "failed" ? "Задание завершилось с ошибкой" : "Задание прервано"));
    return row;
  });
  container.replaceChildren(...(rows.length ? rows : [node("p", "empty", "Сообщений пока нет. Напишите, что нужно сделать.")]));
  state.rendered.messages = signature;
  if (atBottom) container.scrollTop = container.scrollHeight;
  if (!document.hidden && state.tab === "messages" && (window.innerWidth > 700 || $("workspace").classList.contains("show-detail"))) {
    void api(`${chatPath(detail.chat.id)}/read`, "POST", {}).catch(() => {});
  }
}
function renderQueue(detail) {
  $("queue-count").textContent = String(detail.queue.length);
  if (state.edit !== null) return;
  const signature = JSON.stringify(detail.queue);
  if (state.rendered.queue === signature) return;
  const rows = detail.queue.map((item, index) => {
    const card = node("article", "queue-card");
    card.append(node("span", "muted", `${index + 1} · ${item.native ? "Очередь ChatGPT" : `Задание #${item.id}`}${item.retryCount < 0 ? " · доставка не подтверждена" : ""}`), node("p", "", item.body));
    const actions = node("div", "actions");
    const sendNow = button("Отправить сейчас", "queue-send-now", () => write(async () => {
      const result = await api(`${queuePath(item)}/start`, "POST", {});
      toast(result.disposition === "steered" ? "Передано в текущую работу Codex." : "Задание запущено.");
    }));
    sendNow.disabled = item.retryCount < 0;
    const up = button("↑", "", () => write(() => api(queuePath(item), "PATCH", { direction: "up" })), "Переместить выше");
    const down = button("↓", "", () => write(() => api(queuePath(item), "PATCH", { direction: "down" })), "Переместить ниже");
    up.disabled = index === 0 || !!detail.queue[index - 1].native !== !!item.native;
    down.disabled = index === detail.queue.length - 1 || !!detail.queue[index + 1].native !== !!item.native;
    actions.append(sendNow, up, down, button("Изменить", "", () => editQueue(card, item)), button("Убрать", "danger", () => write(() => api(queuePath(item), "DELETE"))));
    card.append(actions); return card;
  });
  $("queue").replaceChildren(...(rows.length ? rows : [node("p", "empty", "Очередь пуста. Сообщения, отправленные во время работы Codex, появятся здесь.")]));
  state.rendered.queue = signature;
}
function editQueue(card, item) {
  state.edit = item.id;
  const input = node("textarea", ""); input.value = item.body; input.setAttribute("aria-label", "Текст задания"); input.maxLength = 12000;
  const actions = node("div", "actions");
  actions.append(button("Сохранить", "", () => write(async () => { await api(queuePath(item), "PATCH", { body: input.value }); state.edit = null; delete state.rendered.queue; })),
    button("Отмена", "", () => { state.edit = null; delete state.rendered.queue; renderQueue(state.detail); }));
  card.replaceChildren(input, actions); input.focus();
}
function renderDiff(detail) {
  const signature = JSON.stringify(detail.diff);
  if (state.rendered.diff === signature) return;
  state.rendered.diff = signature;
  if (!detail.diff?.diff) { $("diff").replaceChildren(node("p", "empty", "Изменений файлов пока нет.")); return; }
  const { diff, turnId } = detail.diff;
  const chatId = state.selected;
  const lines = diff.split("\n");
  const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const summary = node("div", "diff-summary");
  summary.append(node("span", "", `Изменения · +${added} / −${removed}`), button("Скачать .diff ↓", "text-button", () => write(async () => {
    const blob = await api(`${chatPath(chatId)}/diff/${encodeURIComponent(turnId)}`, "GET", undefined, undefined, true);
    const url = URL.createObjectURL(blob);
    const link = node("a", ""); link.href = url; link.download = "changes.diff"; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  })));
  const pre = node("pre", "");
  const visible = lines.slice(0, 3000);
  pre.append(...visible.map((line) => node("span", `diff-line${line.startsWith("+") ? " add" : line.startsWith("-") ? " remove" : line.startsWith("@@") ? " hunk" : ""}`, line || " ")));
  $("diff").replaceChildren(summary, pre);
  if (detail.diff.source === "history") $("diff").insertBefore(node("p", "diff-note", "Последнее задание с правками · изменения по шагам, не текущий git diff."), pre);
  if (lines.length > visible.length) $("diff").append(node("p", "muted", "Показаны первые 3000 строк. Полный diff доступен для скачивания."));
}
function renderRecoveries(detail) {
  const signature = JSON.stringify(detail.recoveries);
  if (state.rendered.recoveries === signature) return;
  state.rendered.recoveries = signature;
  const chatId = state.selected;
  $("recoveries").replaceChildren(...detail.recoveries.map((recovery) => {
    const card = node("article", "recovery", "Задание было прервано или его результат неизвестен. Проверьте переписку перед повтором.");
    card.append(node("p", "muted", recovery.body.slice(0, 160)));
    const actions = node("div", "actions");
    actions.append(button("Повторить", "", () => write(async () => {
      const result = await api(`${chatPath(chatId)}/recoveries/${encodeURIComponent(recovery.turnId)}/retry`, "POST", {});
      toast(result.disposition === "external_busy" ? "Чат сейчас работает в Codex App." : "Задание отправлено повторно.");
    })), button("Скрыть", "", () => write(() => api(`${chatPath(chatId)}/recoveries/${encodeURIComponent(recovery.turnId)}/dismiss`, "POST", {}))));
    card.append(actions); return card;
  }));
}
function renderDetail(detail) {
  $("chat-title").textContent = title(detail.chat);
  $("chat-project").textContent = projectName(detail.chat.projectId);
  $("chat-status").textContent = status(detail.chat);
  $("chat-status").classList.toggle("running", !!detail.chat.activeTurn || detail.chat.status === "active");
  $("chat-status").title = status(detail.chat);
  $("chat-title").title = `${title(detail.chat)} · ${projectName(detail.chat.projectId)} · ${status(detail.chat)}`;
  $("stop").hidden = !detail.chat.activeTurn;
  renderMessages(detail); renderQueue(detail); renderDiff(detail); renderRecoveries(detail);
}
async function refresh(force = false) {
  if (state.polling || (!force && (document.hidden || state.writing))) return;
  state.polling = true;
  try {
    const result = await api("/state");
    if (state.writing) return;
    state.chats = result.chats;
    const projectsChanged = JSON.stringify(state.projects) !== JSON.stringify(result.projects);
    state.projects = result.projects;
    if (projectsChanged) {
      const selected = $("project").value;
      const options = [new Option("Все проекты", ""), ...state.projects.map((project) => new Option(project.alias, String(project.id)))];
      $("project").replaceChildren(...options); $("project").value = selected;
    }
    connection(result.ready ? "Codex на связи" : "Codex отключён", result.ready ? "ready" : "error");
    renderList();
    const id = state.selected;
    if (id) {
      const detail = await api(chatPath(id));
      if (id === state.selected && !state.writing) { state.detail = detail; renderDetail(detail); }
    }
  } catch (error) {
    connection("Нет соединения", "error");
    if (state.selected) $("chat-status").textContent = "Нет соединения. Переоткройте Mini App кнопкой в боте.";
    if (force) toast(error.message, true);
  } finally { state.polling = false; }
}
async function openChat(id) {
  if (state.writing) return;
  state.selected = id; state.detail = null; state.rendered = {}; state.edit = null;
  $("workspace").classList.add("show-detail");
  $("welcome").hidden = true; $("conversation").hidden = false;
  $("prompt").value = draft().text;
  $("messages").replaceChildren(node("p", "empty", "Загружаем переписку…"));
  $("queue").replaceChildren(); $("diff").replaceChildren(); $("recoveries").replaceChildren();
  $("chat-title").textContent = title(state.chats.find((chat) => chat.id === id) || {});
  $("chat-status").textContent = "Загрузка…"; $("stop").hidden = true;
  switchTab("messages"); renderList();
  try {
    await api(`${chatPath(id)}/open`, "POST", {});
    const detail = await api(chatPath(id));
    if (state.selected === id) { state.detail = detail; renderDetail(detail); }
  } catch (error) { toast(error.message, true); }
}
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll("[data-tab]").forEach((el) => { el.classList.toggle("active", el.dataset.tab === tab); el.setAttribute("aria-pressed", String(el.dataset.tab === tab)); });
  for (const id of ["messages", "queue", "diff"]) $(id).hidden = id !== tab;
  $("compose").hidden = tab !== "messages";
  if (tab === "messages") sizePrompt();
}
async function write(action) {
  if (state.writing) return;
  state.writing = true;
  const buttons = [...document.querySelectorAll("button")].filter((el) => !el.disabled);
  buttons.forEach((el) => { el.disabled = true; });
  try { await action(); }
  catch (error) { toast(error.name === "TimeoutError" ? "Нет ответа. Проверьте состояние чата перед повтором." : error.message, true); }
  finally { state.writing = false; buttons.forEach((el) => { if (el.isConnected) el.disabled = false; }); await refresh(true); }
}
$("search").addEventListener("input", renderList);
$("filters-toggle").addEventListener("click", () => { const open = $("filters").hidden; showFilters(open); if (open) $("search").focus(); });
$("project").addEventListener("change", renderList);
$("refresh").addEventListener("click", () => refresh(true));
function closeChat() {
  document.activeElement?.blur?.();
  $("workspace").classList.remove("show-detail");
}
$("back").addEventListener("click", closeChat);
let chatSwipe = null;
$("conversation").addEventListener("touchstart", (event) => {
  chatSwipe = null;
  if (event.touches.length !== 1 || window.innerWidth > 700 || !$("workspace").classList.contains("show-detail")) return;
  if (!(event.target instanceof Element) || event.target.closest("input, textarea, select, button, a, label, [contenteditable], pre, .message-table")) return;
  if (window.getSelection()?.toString()) return;
  const touch = event.touches[0];
  chatSwipe = { id: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp };
}, { passive: true });
$("conversation").addEventListener("touchmove", (event) => {
  if (!chatSwipe) return;
  const touch = [...event.touches].find((item) => item.identifier === chatSwipe.id);
  if (event.touches.length !== 1 || !touch || Math.abs(touch.clientY - chatSwipe.y) > 40 || touch.clientX < chatSwipe.x - 15) chatSwipe = null;
}, { passive: true });
$("conversation").addEventListener("touchcancel", () => { chatSwipe = null; }, { passive: true });
$("conversation").addEventListener("touchend", (event) => {
  const start = chatSwipe; chatSwipe = null;
  if (!start || event.touches.length || event.timeStamp - start.time > 700 || window.getSelection()?.toString()) return;
  const touch = [...event.changedTouches].find((item) => item.identifier === start.id);
  if (!touch) return;
  const dx = touch.clientX - start.x, dy = Math.abs(touch.clientY - start.y);
  if (dx >= 80 && dx > dy * 2) closeChat();
}, { passive: true });
document.querySelectorAll("[data-tab]").forEach((el) => el.addEventListener("click", () => switchTab(el.dataset.tab)));
$("new-chat").addEventListener("click", () => {
  const projectId = Number($("project").value);
  if (!projectId) { showFilters(true); $("project").focus(); toast("Выберите проект для нового чата."); return; }
  let newId;
  void write(async () => { const result = await api("/chats", "POST", { projectId }); newId = result.chat.id; }).then(() => { if (newId) void openChat(newId); });
});
$("stop").addEventListener("click", () => write(async () => { await api(`${chatPath()}/stop`, "POST", {}); toast("Отправлен запрос на остановку."); }));
$("prompt").addEventListener("input", () => { const current = draft(); current.text = $("prompt").value; current.key = crypto.randomUUID(); sizePrompt(); });
$("prompt").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && window.matchMedia("(min-width:701px)").matches) { event.preventDefault(); $("compose").requestSubmit(); } });
$("compose").addEventListener("submit", (event) => {
  event.preventDefault();
  const current = draft(); const text = current.text.trim(); const chatId = state.selected; const key = current.key;
  if (!text || !chatId) return;
  void write(async () => {
    const result = await api(`${chatPath(chatId)}/prompts`, "POST", { text }, key);
    if (result.disposition === "external_busy") { current.key = crypto.randomUUID(); toast("ChatGPT на Mac удерживает запись в этот чат. Сообщение не отправлено — текст остался в поле.", true); return; }
    if (current.key === key) { current.text = ""; current.key = crypto.randomUUID(); if (chatId === state.selected) { $("prompt").value = ""; sizePrompt(); } }
    toast(result.disposition === "queued_external" ? "Передано в очередь ChatGPT на Mac." : result.disposition === "queued" ? "Добавлено в очередь." : "Codex приступил к работе.");
  });
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && tg?.initData) void refresh(); });
// iOS WebViews keep the keyboard open when tapping non-focusable content.
// Click's target is already fixed, so blur cannot move Send out from under a tap.
// Capture lets buttons intentionally focus a new field afterwards (search/edit).
document.addEventListener("click", (event) => {
  const focused = document.activeElement;
  if (!focused?.matches("input, textarea, select, [contenteditable='true']")) return;
  if (!(event.target instanceof Element) || event.target.closest("input, textarea, select, [contenteditable='true'], label")) return;
  focused.blur();
}, true);
if (!tg?.initData) {
  $("gate").hidden = false; connection("Вход через Telegram");
} else {
  $("workspace").hidden = false;
  void refresh(true);
  setInterval(() => void refresh(), 4000);
}
