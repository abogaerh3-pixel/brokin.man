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
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// إعدادات Supabase Storage
const SUPABASE_URL = "https://ihajjvjupakohnovwvem.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_6MFGRFQLtoll_RsADVLpXw_EPAB-80h";
const SUPABASE_BUCKET = "media";

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

let currentUser = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let isChatOpen = false;
let isInitialLoad = true;
let knownMessageIds = new Set();
let unreadCount = 0;

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

// صوت تنبيه خفيف عند وصول رسالة أو إرسالها
function playNotificationTone(isIncoming = true) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(isIncoming ? 880 : 520, ctx.currentTime);
    if (isIncoming) {
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.09);
    }
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.22);
  } catch (e) {}
}

// فحص حالة الإشعارات وعرضها بشكل متوافق مع PWA و Safari
async function getNotifPermissionState() {
  if ("Notification" in window) {
    return Notification.permission;
  }
  if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg && reg.pushManager) {
        const status = await reg.pushManager.permissionState({ userVisibleOnly: true });
        return status;
      }
    } catch (e) {}
  }
  return "unsupported";
}

async function triggerBrowserNotification(title, bodyText) {
  const perm = await getNotifPermissionState();
  if (perm !== "granted") return;

  const options = {
    body: bodyText,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: "brokin-new-msg",
    renotify: true,
    vibrate: [120, 60, 120]
  };

  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification(title, options);
        return;
      }
    }
  } catch (e) {}

  try {
    if ("Notification" in window) {
      const notif = new Notification(title, options);
      notif.onclick = () => {
        window.focus();
        window.openChat();
        notif.close();
      };
    }
  } catch (e) {}
}

async function updateNotifUI() {
  const banner = document.getElementById("notifBanner");
  const btn = document.getElementById("notifBtn");
  const perm = await getNotifPermissionState();

  if (perm === "granted") {
    if (banner) banner.style.display = "none";
    if (btn) btn.classList.add("active-notif");
  } else if (perm === "default") {
    if (banner) banner.style.display = "flex";
  } else {
    if (banner) banner.style.display = "none";
  }
}

window.requestNotifPermission = async () => {
  if (!("Notification" in window)) {
    alert("على الآيفون، ثبّت التطبيق على الشاشة الرئيسية عبر مشاركة ثم إضافة إلى الشاشة الرئيسية لتفعيل الإشعارات");
    return;
  }
  const perm = await Notification.requestPermission();
  await updateNotifUI();
  if (perm === "granted") {
    playNotificationTone(true);
    await triggerBrowserNotification("BROKIN Chat", "تم تفعيل الإشعارات بنجاح 🔔");
  }
};

// تسجيل الدخول والخروج
window.login = async () => {
  const email = document.getElementById("email").value.trim();
  const pass = document.getElementById("password").value;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    document.getElementById("error").innerText = "خطأ في البيانات أو غير مصرح لك بالدخول";
  }
};

window.logoutUser = async () => {
  await signOut(auth);
  location.reload();
};

// التنقل بين واجهة ما قبل المحادثة وشاشة المحادثة
window.openChat = () => {
  isChatOpen = true;
  unreadCount = 0;
  updateUnreadBadge();
  document.getElementById("lobby-screen").style.display = "none";
  document.getElementById("chat-screen").style.display = "flex";
  const messagesDiv = document.getElementById("messages");
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
};

window.backToLobby = () => {
  isChatOpen = false;
  document.getElementById("chat-screen").style.display = "none";
  document.getElementById("lobby-screen").style.display = "block";
};

function updateUnreadBadge() {
  const badge = document.getElementById("unreadBadge");
  if (!badge) return;
  if (unreadCount > 0) {
    badge.style.display = "inline-flex";
    badge.innerText = unreadCount > 99 ? "99+" : unreadCount;
    document.title = `(${unreadCount}) BROKIN Chat`;
  } else {
    badge.style.display = "none";
    document.title = "BROKIN Chat";
  }
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    currentUser = user;
    document.getElementById("userEmailDisplay").innerText = user.email || "مستخدم مصرح";
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("lobby-screen").style.display = "block";
    document.getElementById("chat-screen").style.display = "none";
    updateNotifUI();
    loadMessages();

    const params = new URLSearchParams(window.location.search);
    if (params.get("openChat") === "1") {
      window.openChat();
      window.history.replaceState({}, "", "./");
    }
  } else {
    document.getElementById("login-screen").style.display = "flex";
    document.getElementById("lobby-screen").style.display = "none";
    document.getElementById("chat-screen").style.display = "none";
  }
});

// رفع الملفات إلى Supabase Storage
async function uploadToSupabase(fileOrBlob, ext) {
  const fileName = `${currentUser.uid}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${fileName}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "apikey": SUPABASE_ANON_KEY,
      "Content-Type": fileOrBlob.type || "application/octet-stream",
      "x-upsert": "false"
    },
    body: fileOrBlob
  });
  if (!res.ok) throw new Error("فشل رفع الملف");
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${fileName}`;
}

function formatTime(ts) {
  if (!ts || !ts.toDate) return "";
  const d = ts.toDate();
  return d.toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" });
}

function getPreviewLabel(data) {
  if (data.text) return data.text;
  if (data.type === "image") return "📷 صورة";
  if (data.type === "video") return "🎥 مقطع فيديو";
  if (data.type === "audio") return "🎤 بصمة صوتية";
  return "رسالة جديدة";
}

// الاستماع للرسائل وتحديث الواجهة والإشعارات
function loadMessages() {
  const q = query(collection(db, "messages"), orderBy("createdAt", "asc"));
  const messagesDiv = document.getElementById("messages");

  onSnapshot(q, (snapshot) => {
    messagesDiv.innerHTML = "";
    let lastVisibleMsg = null;

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const docId = docSnap.id;

      // تجاهل الرسائل المخفية لهذا المستخدم
      if (Array.isArray(data.hiddenFor) && data.hiddenFor.includes(currentUser.uid)) {
        knownMessageIds.add(docId);
        return;
      }

      lastVisibleMsg = data;

      // فحص إذا كانت رسالة جديدة وصلت بعد فتح التطبيق
      if (!isInitialLoad && !knownMessageIds.has(docId)) {
        const isFromOther = data.uid !== currentUser.uid;
        if (isFromOther) {
          playNotificationTone(true);
          triggerBrowserNotification("رسالة جديدة في BROKIN", getPreviewLabel(data));
          if (!isChatOpen || document.hidden) {
            unreadCount++;
            updateUnreadBadge();
          }
        } else {
          playNotificationTone(false);
        }
      }
      knownMessageIds.add(docId);

      const div = document.createElement("div");
      div.className = "msg " + (data.uid === currentUser.uid ? "me" : "other");

      if (data.text) {
        const p = document.createElement("p");
        p.textContent = data.text;
        div.appendChild(p);
      }
      if (data.type === "image" && data.url) {
        const wrap = document.createElement("div");
        wrap.className = "media-wrap";

        const img = document.createElement("img");
        img.src = data.url;
        img.alt = "صورة مرسلة";
        img.onclick = (e) => {
          e.stopPropagation();
          window.openMediaLightbox("image", data.url);
        };
        img.onload = () => { messagesDiv.scrollTop = messagesDiv.scrollHeight; };

        const expandBtn = document.createElement("button");
        expandBtn.type = "button";
        expandBtn.className = "expand-media-btn";
        expandBtn.textContent = "⛶";
        expandBtn.title = "فتح الصورة";
        expandBtn.onclick = (e) => {
          e.stopPropagation();
          window.openMediaLightbox("image", data.url);
        };

        wrap.appendChild(img);
        wrap.appendChild(expandBtn);
        div.appendChild(wrap);
      }
      if (data.type === "video" && data.url) {
        const wrap = document.createElement("div");
        wrap.className = "media-wrap";

        const vid = document.createElement("video");
        vid.src = data.url;
        vid.controls = true;
        vid.playsInline = true;

        const expandBtn = document.createElement("button");
        expandBtn.type = "button";
        expandBtn.className = "expand-media-btn";
        expandBtn.textContent = "⛶ فتح";
        expandBtn.title = "فتح الفيديو في العارض";
        expandBtn.onclick = (e) => {
          e.stopPropagation();