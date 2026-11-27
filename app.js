import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
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

// بيانات Supabase Storage للملفات المجانية
const SUPABASE_URL = "https://ihajjvjupakohnovwvem.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_6MFGRFQLtoll_RsADVLpXw_EPAB-80h";
const SUPABASE_BUCKET = "media";

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

window.login = async () => {
  const email = document.getElementById("email").value;
  const pass = document.getElementById("password").value;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    document.getElementById("error").innerText = "خطأ في البيانات أو غير مصرح لك بالدخول";
  }
};

onAuthStateChanged(auth, (user) => {
  if (user) {
    currentUser = user;
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("chat-screen").style.display = "flex";
    loadMessages();
  }
});

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

function loadMessages() {
  const q = query(collection(db, "messages"), orderBy("createdAt", "asc"));
  const messagesDiv = document.getElementById("messages");

  onSnapshot(q, (snapshot) => {
    messagesDiv.innerHTML = "";
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();

      // تجاهل الرسائل التي حذفها المستخدم الحالي من عنده فقط
      if (Array.isArray(data.hiddenFor) && data.hiddenFor.includes(currentUser.uid)) {
        return;
      }

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
        img.onload = () => messagesDiv.scrollTop = messagesDiv.scrollHeight;
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
      messagesDiv.appendChild(div);
    });
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  });
}

// دالة حذف المحادثة (self = من عندي فقط | both = للطرفين)
window.handleDeleteChat = async (mode) => {
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