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

// إظهار إشعار المتصفح / النظام
function triggerBrowserNotification(title, bodyText) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    try {
      const notif = new Notification(title, {
        body: bodyText,
        icon: "./icon-192.png",
        badge: "./icon-192.png",
        tag: "brokin-new-msg"
      });
      notif.onclick = () => {
        window.focus();
        window.openChat();
        notif.close();
      };
    } catch (e) {}
  }
}

function updateNotifUI() {
  const banner = document.getElementById("notifBanner");
  const btn = document.getElementById("notifBtn");
  if (!("Notification" in window)) {
    if (banner) banner.style.display = "none";
    return;
  }
  if (Notification.permission === "granted") {
    if (banner) banner.style.display = "none";
    if (btn) btn.classList.add("active-notif");
  } else if (Notification.permission === "default") {
    if (banner) banner.style.display = "flex";
  }
}

window.requestNotifPermission = async () => {
  if (!("Notification" in window)) {
    alert("متصفحك لا يدعم إشعارات النظام");
    return;
  }
  const perm = await Notification.requestPermission();
  updateNotifUI();
  if (perm === "granted") {
    playNotificationTone(true);
    triggerBrowserNotification("BROKIN Chat", "تم تفعيل الإشعارات بنجاح 🔔");
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
        const img = document.createElement("img");
        img.src = data.url;
        img.onload = () => { messagesDiv.scrollTop = messagesDiv.scrollHeight; };
        div.appendChild(img);
      }
      if (data.type === "video" && data.url) {
        const vid = document.createElement("video");
        vid.src = data.url;
        vid.controls = true;
        vid.playsInline = true;
        div.appendChild(vid);
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
    });

    // تحديث معاينة آخر رسالة في واجهة ما قبل المحادثة
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