/* ===========================================================
   PWAfy — assistant.js
   PWAfy AI: a small chat widget that knows the site (pricing, the
   scan-vs-manual flow, what's in the generated zip, the FAQ). The
   model call itself happens entirely on PWAfy's own Cloudflare
   Worker (see /ask-pwafy-ai in proxy-worker.js), no API key of any
   kind ever ships to the browser. All credit shown to the user
   points at PWAfy / ayocodes, never at whichever model runs behind
   the scenes.
   Built by AYOCODES
   =========================================================== */

const ASSISTANT_HISTORY_LIMIT = 8; // messages kept as context, oldest dropped first
let assistantHistory = [];
let assistantBusy = false;
let assistantOpened = false;

function assistantEndpointReady() {
  return PROXY_CONFIGURED;
}

function appendAssistantMessage(role, text) {
  const list = document.getElementById("aiMessages");
  if (!list) return;
  const bubble = document.createElement("div");
  bubble.className = "ai-msg " + role;
  bubble.textContent = text;
  list.appendChild(bubble);
  list.scrollTop = list.scrollHeight;
}

function appendAssistantNote(text) {
  const list = document.getElementById("aiMessages");
  if (!list) return;
  const note = document.createElement("div");
  note.className = "ai-msg system-note";
  note.textContent = text;
  list.appendChild(note);
  list.scrollTop = list.scrollHeight;
}

function openAssistantPanel() {
  document.getElementById("aiPanel").classList.add("open");
  if (!assistantOpened) {
    assistantOpened = true;
    appendAssistantMessage(
      "assistant",
      "Hi, I'm PWAfy AI. Ask me about pricing, the scan vs manual flow, what's in the generated zip, or anything else about PWAfy.",
    );
    if (!assistantEndpointReady()) {
      appendAssistantNote(
        "PWAfy AI isn't connected yet, this is a preview. Deploy the Worker and add a Groq key server-side to enable it.",
      );
    }
  }
  document.getElementById("aiInput").focus();
}

function closeAssistantPanel() {
  document.getElementById("aiPanel").classList.remove("open");
}

async function sendAssistantMessage() {
  if (assistantBusy) return;
  const input = document.getElementById("aiInput");
  const sendBtn = document.getElementById("btnAiSend");
  const message = (input.value || "").trim();
  if (!message) return;

  appendAssistantMessage("user", message);
  input.value = "";

  if (!assistantEndpointReady()) {
    appendAssistantNote(
      "PWAfy AI isn't connected yet, this is a preview of the chat UI only.",
    );
    return;
  }

  assistantHistory.push({ role: "user", content: message });
  assistantHistory = assistantHistory.slice(-ASSISTANT_HISTORY_LIMIT);

  assistantBusy = true;
  sendBtn.disabled = true;
  appendAssistantNote("PWAfy AI is thinking\u2026");

  try {
    const res = await fetch(CONFIG.PROXY_URL + "/ask-pwafy-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history: assistantHistory.slice(0, -1) }),
    });
    const list = document.getElementById("aiMessages");
    const lastNote = list.querySelector(".ai-msg.system-note:last-child");
    if (lastNote) lastNote.remove();

    const data = await res.json();
    if (!res.ok) {
      appendAssistantNote(
        data.error || "Couldn't reach PWAfy AI right now, try again shortly.",
      );
      assistantHistory.pop();
      return;
    }
    appendAssistantMessage("assistant", data.reply);
    assistantHistory.push({ role: "assistant", content: data.reply });
    assistantHistory = assistantHistory.slice(-ASSISTANT_HISTORY_LIMIT);
  } catch (e) {
    const list = document.getElementById("aiMessages");
    const lastNote = list.querySelector(".ai-msg.system-note:last-child");
    if (lastNote) lastNote.remove();
    appendAssistantNote(
      "Couldn't reach the server, check your connection and try again.",
    );
    assistantHistory.pop();
  } finally {
    assistantBusy = false;
    sendBtn.disabled = false;
  }
}

function initAssistant() {
  const launcher = document.getElementById("aiLauncher");
  const closeBtn = document.getElementById("btnCloseAi");
  const sendBtn = document.getElementById("btnAiSend");
  const input = document.getElementById("aiInput");
  if (!launcher || !closeBtn || !sendBtn || !input) return;

  launcher.onclick = () => {
    const panel = document.getElementById("aiPanel");
    if (panel.classList.contains("open")) closeAssistantPanel();
    else openAssistantPanel();
  };
  closeBtn.onclick = closeAssistantPanel;
  sendBtn.onclick = sendAssistantMessage;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendAssistantMessage();
  });
}
