import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  doc,
  setDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getMessaging,
  getToken,
  onMessage
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

// إعدادات Supabase Storage
const SUPABASE_URL = "https://ihajjvjupakohnovwvem.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_6MFGRFQLtoll_RsADVLpXw_EPAB-80h";
const SUPABASE_BUCKET = "media";

// مفتاح VAPID العام من Firebase Cloud Messaging
const VAPID_PUBLIC_KEY = "BLkLmRkNqorcmlh0HN8Zuyiv0qpD6YW1Syef8h-1l5qpSCTfPHYA-GXHmoZBJaioV3-NLJOLGQn-EgsgE2Frji4";

// إعدادات Firebase
const firebaseConfig = {
  apiKey: "AIzaSyA2H-_azPTkh19WzcGiitPMMTNvYMzXbgw",
  authDomain: "brokin-384aa.firebaseapp.com",
  projectId: "brokin-384aa",
  storageBucket: "brokin-384aa.firebasestorage.app",
  messagingSenderId: "32448932711",
  appId: "1:32448932711:web:cdf83819cca005089bddc2"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
let messaging = null;
try {
  messaging = getMessaging(app);
} catch (e) {}

let currentUser = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let isChatOpen = false;
let isInitialLoad = true;
let knownMessageIds = new Set();
let unreadCount = 0;
let unsubscribeMessages = null;

function getSeenStorageKey() {
  return currentUser ? `brokin_seen_msgs_${currentUser.uid}` : null;
}

function loadPersistedSeenIds() {
  knownMessageIds = new Set();
  const key = getSeenStorageKey();
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      knownMessageIds = new Set(arr.slice(-300));
    }
  } catch (e) {}
}

function persistSeenIds() {
  const key = getSeenStorageKey();
  if (!key) return;
  try {
    const arr = Array.from(knownMessageIds).slice(-300);
    localStorage.setItem(key, JSON.stringify(arr));
  } catch (e) {}
}

// عارض الصور والفيديو داخل المحادثة
window.openMediaLightbox = (type, url) => {
  const overlay = document.getElementById("mediaLightbox");
  const stage = document.getElementById("lightboxStage");
  const label = document.getElementById("lightboxLabel");
  if (!overlay || !stage || !url) return;

  stage.innerHTML = "";
  if (type === "image") {
    label.textContent = "اضغط على الصورة للتكبير أو التصغير";
    const img = document.createElement("img");
    img.src = url;
    img.alt = "صورة";
    img.onclick = (e) => {
      e.stopPropagation();
      img.classList.toggle("zoomed");
    };
    stage.appendChild(img);
  } else if (type === "video") {
    label.textContent = "مشغل الفيديو";
    const vid = document.createElement("video");
    vid.src = url;
    vid.controls = true;
    vid.autoplay = true;
    vid.playsInline = true;
    stage.appendChild(vid);
  }

  overlay.classList.add("open");
};

window.closeMediaLightbox = () => {
  const overlay = document.getElementById("mediaLightbox");
  const stage = document.getElementById("lightboxStage");
  if (stage) {
    const vid = stage.querySelector("video");
    if (vid) {
      vid.pause();
      vid.removeAttribute("src");
      vid.load();
    }
    stage.innerHTML = "";
  }
  if (overlay) overlay.classList.remove("open");
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.closeMediaLightbox();
});

// صوت واهتزاز تنبيه خفيف
function playNotificationTone(isIncoming = true) {
  try {
    if (isIncoming && "vibrate" in navigator) {
      navigator.vibrate([120, 60, 120]);
    }
  } catch (e) {}

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(isIncoming ? 880 : 660, ctx.currentTime);

    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.24);
    osc.onended = () => {
      ctx.close().catch(() => {});
    };
  } catch (e) {}
}

// طلب إذن الإشعارات وحفظ FCM Token للمستخدم الحالي
async function registerPushToken() {
  try {
    if (!currentUser || !messaging || !("Notification" in window)) return;
    if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.includes("ضع_مفتاح")) return;

    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") return;

    const swRegistration = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, {
      vapidKey: VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: swRegistration
    });

    if (token) {
      const tokenDocId = `${currentUser.uid}_${btoa(token).slice(-24).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      await setDoc(
        doc(db, "fcmTokens", tokenDocId),
        {
          uid: currentUser.uid,
          email: currentUser.email || "",
          token,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    }
  } catch (err) {
    console.warn("FCM token registration skipped/failed:", err);
  }
}

// استقبال الإشعارات والتطبيق مفتوح في المقدمة
if (messaging) {
  onMessage(messaging, (payload) => {
    try {
      const title = payload?.notification?.title || "رسالة جديدة في BROKIN";
      const body = payload?.notification?.body || "لديك رسالة جديدة";
      if (!isChatOpen) {
        playNotificationTone(true);
      }
      if (Notification.permission === "granted" && document.hidden) {
        new Notification(title, {
          body,
          icon: "./icon-192.png"
        });
      }
    } catch (e) {}
  });
}

// رفع ملف إلى Supabase Storage وإرجاع الرابط العام
async function uploadToSupabase(file, folder = "uploads") {
  const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const objectPath = `${folder}/${safeName}`;
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${objectPath}`;

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": file.type || "application/octet-stream",
      "x-upsert": "true"
    },
    body: file
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`فشل رفع الملف إلى Supabase (${res.status}): ${errText}`);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`;
}

// عرض رسالة واحدة داخل واجهة المحادثة
function renderMessage(docId, msg) {
  const messagesEl = document.getElementById("messages");
  if (!messagesEl) return;

  const existing = document.getElementById(`msg_${docId}`);
  if (existing) existing.remove();

  const isMine = currentUser && msg.uid === currentUser.uid;
  const row = document.createElement("div");
  row.id = `msg_${docId}`;
  row.className = `msg-row ${isMine ? "mine" : "other"}`;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (msg.type === "image" && msg.mediaUrl) {
    const img = document.createElement("img");
    img.src = msg.mediaUrl;
    img.alt = "صورة";
    img.className = "msg-image";
    img.loading = "lazy";
    img.onclick = () => window.openMediaLightbox("image", msg.mediaUrl);
    bubble.appendChild(img);
  } else if (msg.type === "video" && msg.mediaUrl) {
    const vid = document.createElement("video");
    vid.src = msg.mediaUrl;
    vid.controls = true;
    vid.playsInline = true;
    vid.className = "msg-video";
    bubble.appendChild(vid);
  } else if (msg.type === "audio" && msg.mediaUrl) {
    const aud = document.createElement("audio");
    aud.src = msg.mediaUrl;
    aud.controls = true;
    aud.className = "msg-audio";
    bubble.appendChild(aud);
  }

  if (msg.text) {
    const p = document.createElement("div");
    p.className = "msg-text";
    p.textContent = msg.text;
    bubble.appendChild(p);
  }

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const timeStr = msg.createdAt?.toDate
    ? msg.createdAt.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  meta.textContent = timeStr;
  bubble.appendChild(meta);

  row.appendChild(bubble);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// الاستماع للرسائل من Firestore
function startMessagesListener() {
  if (unsubscribeMessages) {
    unsubscribeMessages();
    unsubscribeMessages = null;
  }

  const messagesEl = document.getElementById("messages");
  if (messagesEl) messagesEl.innerHTML = "";

  isInitialLoad = true;
  loadPersistedSeenIds();

  const q = query(collection(db, "messages"), orderBy("createdAt", "asc"));
  unsubscribeMessages = onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added" || change.type === "modified") {
        const msgId = change.doc.id;
        const data = change.doc.data() || {};
        renderMessage(msgId, data);

        const isNewIncoming =
          change.type === "added" &&
          !isInitialLoad &&
          !knownMessageIds.has(msgId) &&
          currentUser &&
          data.uid !== currentUser.uid;

        if (isNewIncoming) {
          knownMessageIds.add(msgId);
          persistSeenIds();
          playNotificationTone(true);
          if (!isChatOpen) {
            unreadCount += 1;
            updateUnreadBadge();
          }
        } else if (change.type === "added") {
          knownMessageIds.add(msgId);
        }
      }
    });

    if (isInitialLoad) {
      persistSeenIds();
      isInitialLoad = false;
    }
  });
}

function updateUnreadBadge() {
  const badge = document.getElementById("unreadBadge");
  if (!badge) return;
  if (unreadCount > 0) {
    badge.textContent = String(unreadCount);
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }
}

// إرسال رسالة نصية
async function sendTextMessage() {
  const input = document.getElementById("messageInput");
  if (!input || !currentUser) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  try {
    await addDoc(collection(db, "messages"), {
      uid: currentUser.uid,
      email: currentUser.email || "",
      type: "text",
      text,
      createdAt: serverTimestamp()
    });
    playNotificationTone(false);
  } catch (err) {
    console.error("Failed to send message:", err);
    input.value = text;
  }
}

// إرسال ملف وسائط (صورة / فيديو / صوت)
async function sendMediaFile(file, forcedType = null) {
  if (!file || !currentUser) return;

  let type = forcedType;
  if (!type) {
    if (file.type.startsWith("image/")) type = "image";
    else if (file.type.startsWith("video/")) type = "video";
    else if (file.type.startsWith("audio/")) type = "audio";
    else type = "file";
  }

  const folderMap = {
    image: "images",
    video: "videos",
    audio: "audio",
    file: "files"
  };

  try {
    const mediaUrl = await uploadToSupabase(file, folderMap[type] || "uploads");
    await addDoc(collection(db, "messages"), {
      uid: currentUser.uid,
      email: currentUser.email || "",
      type,
      mediaUrl,
      text: "",
      createdAt: serverTimestamp()
    });
    playNotificationTone(false);
  } catch (err) {
    console.error("Media upload failed:", err);
    alert(err.message || "تعذر رفع الملف");
  }
}

// تسجيل الصوت
async function toggleAudioRecording() {
  const btn = document.getElementById("recordBtn");
  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        const ext = blob.type.includes("mp4") ? "m4a" : "webm";
        const file = new File([blob], `voice_${Date.now()}.${ext}`, { type: blob.type });
        await sendMediaFile(file, "audio");
      };
      mediaRecorder.start();
      isRecording = true;
      if (btn) btn.classList.add("recording");
    } catch (err) {
      alert("يرجى السماح بالوصول إلى المايكروفون");
    }
  } else {
    try {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    } catch (e) {}
    isRecording = false;
    if (btn) btn.classList.remove("recording");
  }
}

// إدارة حالة تسجيل الدخول والواجهة
function showAuthScreen() {
  const authScreen = document.getElementById("authScreen");
  const chatScreen = document.getElementById("chatScreen");
  if (authScreen) authScreen.style.display = "flex";
  if (chatScreen) chatScreen.style.display = "none";
  isChatOpen = false;
}

function showChatScreen() {
  const authScreen = document.getElementById("authScreen");
  const chatScreen = document.getElementById("chatScreen");
  if (authScreen) authScreen.style.display = "none";
  if (chatScreen) chatScreen.style.display = "flex";
  isChatOpen = true;
  unreadCount = 0;
  updateUnreadBadge();
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user || null;
  if (currentUser) {
    showChatScreen();
    startMessagesListener();
    await registerPushToken();
  } else {
    if (unsubscribeMessages) {
      unsubscribeMessages();
      unsubscribeMessages = null;
    }
    showAuthScreen();
  }
});

// ربط الأحداث بعد تحميل DOM
document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("emailInput")?.value?.trim() || "";
      const password = document.getElementById("passwordInput")?.value || "";
      const errEl = document.getElementById("authError");
      if (errEl) errEl.textContent = "";

      try {
        await signInWithEmailAndPassword(auth, email, password);
      } catch (err) {
        if (errEl) errEl.textContent = "بيانات الدخول غير صحيحة أو الحساب غير مفعل";
      }
    });
  }

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await signOut(auth);
      } catch (e) {}
    });
  }

  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) sendBtn.addEventListener("click", sendTextMessage);

  const messageInput = document.getElementById("messageInput");
  if (messageInput) {
    messageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendTextMessage();
      }
    });
  }

  const mediaInput = document.getElementById("mediaInput");
  if (mediaInput) {
    mediaInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (file) await sendMediaFile(file);
      e.target.value = "";
    });
  }

  const recordBtn = document.getElementById("recordBtn");
  if (recordBtn) {
    recordBtn.addEventListener("click", toggleAudioRecording);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("SW registration warning:", err);
    });
  }
});