/* ============================================================
   firebase-config.js
   ------------------------------------------------------------
   請把下面的值換成你自己 Firebase 專案的設定（Firebase 主控台 →
   齒輪圖示「專案設定」→ 往下捲到「你的應用程式」→ 網頁應用程式那組設定）。
   這組設定不是密碼，公開寫在網頁程式碼裡是 Firebase 官方建議的正常做法，
   不用擔心外洩——真正的存取權限是靠 Firestore 安全規則（firestore.rules）
   跟 Google 登入網域限制在把關。
   ============================================================ */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyCInpVFRaiTM5x9iV7Qelm4Un50LUJBarc",
  authDomain: "lwcps-awards.firebaseapp.com",
  projectId: "lwcps-awards",
  storageBucket: "lwcps-awards.firebasestorage.app",
  messagingSenderId: "927485448948",
  appId: "1:927485448948:web:f5f8ccaf5bbeda1ed6c4a1"
};
