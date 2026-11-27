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

// ضع VAPID Key من Firebase Console -> Cloud Messaging -> Web Push certificates
const VAPID_PUBLIC_KEY = "";

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

async function getNotifPermissionState() {
  if ("Notification" in window) {
    return Notification.permission;
  }
  return "unsupported";
}

async function registerFcmTokenIfPossible() {
  if (!messaging || !currentUser || !VAPID_PUBLIC_KEY) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, {
      vapidKey: VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: reg
    });
    if (token) {
      await setDoc(
        doc(db, "fcmTokens", currentUser.uid),
        { uid: currentUser.uid, token, updatedAt: serverTimestamp() },
        { merge: true }
      );
    }
  } catch (e) {}
}

if (messaging) {
  onMessage(messaging, (payload) => {
    const isOutsideChat = !isChatOpen || document.hidden;
    if (isOutsideChat) {
      const title = payload.notification?.title || "رسالة جديدة في BROKIN";
      const body = payload.notification?.body || "لديك رسالة جديدة";
      showSystemNotificationNow(title, body);
      unreadCount++;
      updateUnreadBadge();
    }
  });
}

async function showSystemNotificationNow(title, bodyText) {
  const perm = await getNotifPermissionState();
  if (perm !== "granted") return false;

  const options = {
    body: bodyText,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: "brokin-new-msg-" + Date.now(),
    renotify: true,
    vibrate: [120, 60, 120]
  };

  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification(title, options);
        return true;
      }
    } catch (e) {}
  }

  try {
    if ("Notification" in window) {
      const notif = new Notification(title, options);
      notif.onclick = () => {
        window.focus();
        window.openChat();
        notif.close();
      };
      return true;
    }
  } catch (e) {}

  return false;
}

async function triggerBrowserNotification(title, bodyText) {
  return await showSystemNotificationNow(title, bodyText);
}

async function updateNotifUI() {
  const banner = document.getElementById("notifBanner");
  const btn = document.getElementById("notifBtn");
  const perm = await getNotifPermissionState();

  if (perm === "granted") {
    if (banner) banner.style.display = "none";
    if (btn) btn.classList.add("active-notif");
    await registerFcmTokenIfPossible();
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
    await showSystemNotificationNow("BROKIN Chat", "تم تفعيل الإشعارات بنجاح 🔔");
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
  if (unsubscribeMessages) {
    unsubscribeMessages();
    unsubscribeMessages = null;
  }
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
    isInitialLoad = true;
    loadPersistedSeenIds();
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
    currentUser = null;
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
  if (unsubscribeMessages) {
    unsubscribeMessages();
  }

  const q = query(collection(db, "messages"), orderBy("createdAt", "asc"));
  const messagesDiv = document.getElementById("messages");

  unsubscribeMessages = onSnapshot(q, async (snapshot) => {
    messagesDiv.innerHTML = "";
    let lastVisibleMsg = null;
    let seenChanged = false;

    for (const docSnap of snapshot.docs) {
      const data = docSnap.data();
      const docId = docSnap.id;

      if (Array.isArray(data.hiddenFor) && data.hiddenFor.includes(currentUser.uid)) {
        if (!knownMessageIds.has(docId)) {
          knownMessageIds.add(docId);
          seenChanged = true;
        }
        continue;
      }

      lastVisibleMsg = data;

      const isAlreadyKnown = knownMessageIds.has(docId);
      const isFromOther = data.uid !== currentUser.uid;
      const isOutsideChat = !isChatOpen || document.hidden;

      if (!isAlreadyKnown) {
        knownMessageIds.add(docId);
        seenChanged = true;

        if (!isInitialLoad && isFromOther && isOutsideChat) {
          playNotificationTone(true);
          await triggerBrowserNotification("رسالة جديدة في BROKIN", getPreviewLabel(data));
          unreadCount++;
          updateUnreadBadge();
        } else if (!isInitialLoad && !isFromOther) {
          playNotificationTone(false);
        }
      }

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
          vid.pause();
          window.openMediaLightbox("video", data.url);
        };

        wrap.appendChild(vid);
        wrap.appendChild(expandBtn);
        div.appendChild(wrap);
      }
      if (data.type === "audio" && data.url) {
        const aud = document.createElement("audio");
        aud.src = data.url;
        aud.controls = true;
        div.appendChild(aud);
      }

      const timeSpan = document.createElement("span");
      timeSpan.className = "msg-meta";
      timeSpan.textContent = formatTime(data.createdAt);
      div.appendChild(timeSpan);

      messagesDiv.appendChild(div);
    }

    if (seenChanged) {
      persistSeenIds();
    }

    const previewEl = document.getElementById("lastMsgPreview");
    const timeEl = document.getElementById("lastMsgTime");
    if (lastVisibleMsg) {
      previewEl.textContent = (lastVisibleMsg.uid === currentUser.uid ? "أنت: " : "") + getPreviewLabel(lastVisibleMsg);
      timeEl.textContent = formatTime(lastVisibleMsg.createdAt) || "الآن";
    } else {
      previewEl.textContent = "لا توجد رسائل بعد...";
      timeEl.textContent = "--:--";
    }

    isInitialLoad = false;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  });
}

// نافذة وخيارات حذف المحادثة
window.openDeleteModal = () => {
  document.getElementById("deleteModal").style.display = "flex";
};

window.closeDeleteModal = () => {
  document.getElementById("deleteModal").style.display = "none";
};

window.confirmDeleteChat = async (mode) => {
  closeDeleteModal();
  if (!currentUser) return;
  try {
    const snap = await getDocs(collection(db, "messages"));
    if (snap.empty) return;

    const batch = writeBatch(db);
    let hasChanges = false;

    snap.forEach((docSnap) => {
      const data = docSnap.data();
      if (mode === "both") {
        batch.delete(docSnap.ref);
        hasChanges = true;
      } else if (mode === "self") {
        if (!Array.isArray(data.hiddenFor) || !data.hiddenFor.includes(currentUser.uid)) {
          batch.update(docSnap.ref, {
            hiddenFor: arrayUnion(currentUser.uid)
          });
          hasChanges = true;
        }
      }
    });

    if (hasChanges) {
      await batch.commit();
    }
  } catch (e) {
    console.error("Delete chat error:", e);
    alert("تعذر حذف المحادثة، تحقق من صلاحيات Firestore");
  }
};

// إرسال نص
window.sendText = async () => {
  const input = document.getElementById("msgInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";

  await addDoc(collection(db, "messages"), {
    type: "text",
    text: text,
    uid: currentUser.uid,
    createdAt: serverTimestamp()
  });
};

// إرسال صورة أو فيديو
window.sendMedia = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const isVideo = file.type.startsWith("video/");
  const ext = (file.name.split(".").pop() || (isVideo ? "mp4" : "jpg")).toLowerCase();

  try {
    const url = await uploadToSupabase(file, ext);
    await addDoc(collection(db, "messages"), {
      type: isVideo ? "video" : "image",
      url: url,
      uid: currentUser.uid,
      createdAt: serverTimestamp()
    });
  } catch (e) {
    alert("تعذر إرسال الملف، تأكد من إعدادات التخزين");
  }
  event.target.value = "";
};

// تسجيل وإرسال بصمة صوتية
window.toggleRecord = async () => {
  const micBtn = document.getElementById("micBtn");

  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const mime = mediaRecorder.mimeType || "audio/webm";
        const ext = mime.includes("mp4") ? "m4a" : "webm";
        const blob = new Blob(audioChunks, { type: mime });
        try {
          const url = await uploadToSupabase(blob, ext);
          await addDoc(collection(db, "messages"), {
            type: "audio",
            url: url,
            uid: currentUser.uid,
            createdAt: serverTimestamp()
          });
        } catch (e) {
          alert("تعذر إرسال البصمة الصوتية");
        }
      };

      mediaRecorder.start();
      isRecording = true;
      micBtn.classList.add("recording");
    } catch (e) {
      alert("يرجى السماح بالوصول إلى الميكروفون");
    }
  } else {
    mediaRecorder.stop();
    isRecording = false;
    micBtn.classList.remove("recording");
  }
};