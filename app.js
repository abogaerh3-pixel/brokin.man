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
    const AudioCtx =