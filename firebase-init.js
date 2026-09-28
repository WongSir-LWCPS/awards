/* ============================================================
   firebase-init.js
   ------------------------------------------------------------
   把 Firebase（Google 登入 + Firestore 資料庫）包成 app.js 可以直接呼叫的
   window.fbApi 介面。用 Firebase 的 compat（相容）版 SDK，維持全域變數風格，
   跟 app.js 現有「一整個 IIFE、不用 import/export」的寫法一致，不需要把
   app.js 改成 ES module。

   需要 index.html 在這個檔案之前先載入：
     - firebase-app-compat.js / firebase-auth-compat.js / firebase-firestore-compat.js
     - firebase-config.js（提供 window.FIREBASE_CONFIG）
   ============================================================ */
(function(){
  var ALLOWED_DOMAIN = 'lwcps.edu.hk';

  if (!window.FIREBASE_CONFIG){
    console.error('[firebase-init] 找不到 window.FIREBASE_CONFIG，請先在 firebase-config.js 填入 Firebase 專案設定。');
  }

  firebase.initializeApp(window.FIREBASE_CONFIG || {});
  var auth = firebase.auth();
  var db = firebase.firestore();

  // 2026-09-28：拿掉先前在這裡加的「開啟離線持久化」（db.enablePersistence
  // ({synchronizeTabs:true})）。這是回應「新增/匯入獎項後記錄仍然會消失」
  // 持續回報，逐輪排除掉其他可能性後的判斷——加了那個功能之後使用者持續
  // 回報同樣症狀，且最新一輪確認的症狀模式是「新增後在畫面上馬上看得到、
  // 但重新整理視窗後就不見了」，這正是本機持久化快取（IndexedDB）最典型的
  // 一種問題：分頁重新整理時，Firestore SDK 有可能先把本機這份持久化快取
  // 的內容顯示出來，而不是先等伺服器確認過的最新資料，如果這份本機快取
  // 因為任何原因（例如「一次只能有一個分頁真正持有」的多分頁協調機制、
  // 瀏覽器儲存空間被系統回收等，Safari 尤其容易主動清除較舊的網站資料）
  // 沒有正確同步到最新寫入，重新整理後看到的就會是「缺少剛剛新增內容」的
  // 舊快照——跟目前回報的症狀完全吻合。拿掉這個設定後，Firestore 改回預設
  // 行為：不使用本機磁碟持久化，每次分頁重新整理都直接跟伺服器要最新資料
  // （分頁存續期間仍有記憶體內快取，不影響同一次瀏覽期間的正常使用），
  // 沒有本機快取可能「過時」的疑慮。這個學校內部系統本來就假設使用者一直
  // 有網路連線，不特別需要離線也能用的能力，拿掉這個功能不影響正常使用，
  // 只是少了「離線時也能繼續操作、恢復連線後自動補送」這個原本沒被使用者
  // 要求過的額外能力。

  var provider = new firebase.auth.GoogleAuthProvider();
  // hd 只是「登入視窗預設鎖定這個網域的帳號」的體驗優化，真正的防護在下面
  // isAllowedEmail() 這一關，以及 Firestore 規則裡對 email 網域的檢查。
  provider.setCustomParameters({ hd: ALLOWED_DOMAIN });

  function isAllowedEmail(email){
    if (!email) return false;
    email = String(email).toLowerCase();
    var suffix = '@' + ALLOWED_DOMAIN;
    return email.length > suffix.length && email.slice(-suffix.length) === suffix;
  }

  function signIn(){
    return auth.signInWithPopup(provider).then(function(result){
      var email = result.user && result.user.email;
      if (!isAllowedEmail(email)){
        return auth.signOut().then(function(){
          var err = new Error('請使用 @' + ALLOWED_DOMAIN + ' 的帳號登入');
          err.code = 'wrong-domain';
          throw err;
        });
      }
      return result.user;
    });
  }

  function signOutUser(){
    var uid = auth.currentUser && auth.currentUser.uid;
    var dropAdmin = uid ? db.collection('_adminSessions').doc(uid).delete().catch(function(){}) : Promise.resolve();
    return dropAdmin.then(function(){ return auth.signOut(); });
  }

  // cb(user|null) — 每次登入狀態變化（含第一次載入）都會呼叫一次。網域不符的
  // 帳號會被立刻登出，不會把 user 傳給 cb（onAuthStateChanged 之後會再觸發一次、
  // 這次是 null，等於自動幫你擋在門外）。
  function onAuthChange(cb){
    return auth.onAuthStateChanged(function(user){
      if (user && !isAllowedEmail(user.email)){
        auth.signOut();
        return;
      }
      cb(user);
    });
  }

  // 管理員登入：把輸入的密碼寫進「自己」的 _adminSessions 文件，Firestore 規則會核對
  // 密碼是否正確——密碼不對，這個寫入請求本身就會被規則拒絕（收到 permission-denied），
  // 藉此判斷登入成功/失敗，不需要另外維護一份密碼比對邏輯。成功後不需要每次寫入都再
  // 帶密碼，其他規則只看這份文件存不存在、密碼是否仍然吻合。
  function adminLogin(password){
    var user = auth.currentUser;
    if (!user) return Promise.reject(new Error('尚未登入'));
    return db.collection('_adminSessions').doc(user.uid).set({ pass: password, at: Date.now() })
      .then(function(){ return true; })
      .catch(function(err){
        var e = new Error('密碼錯誤');
        e.code = 'wrong-password';
        e.cause = err;
        throw e;
      });
  }

  function adminLogout(){
    var user = auth.currentUser;
    if (!user) return Promise.resolve();
    return db.collection('_adminSessions').doc(user.uid).delete().catch(function(){});
  }

  /* ---------------- 即時資料同步 ---------------- */

  // handlers: { records(arr), studentRosters(arr), clubRosters(arr), settings(obj|null), error(err) }
  // 回傳一個「停止全部監聽」的函式（目前 app.js 用不到，但保留給日後登出時清理用）。
  function startListening(handlers){
    var onErr = handlers.error || function(err){ console.error('[firebase] 同步失敗', err); };
    var unsub = [];
    unsub.push(db.collection('records').onSnapshot(function(snap){
      var arr = [];
      snap.forEach(function(d){ arr.push(d.data()); });
      handlers.records(arr);
    }, onErr));
    unsub.push(db.collection('studentRosters').onSnapshot(function(snap){
      var arr = [];
      snap.forEach(function(d){ arr.push(d.data()); });
      handlers.studentRosters(arr);
    }, onErr));
    unsub.push(db.collection('clubRosters').onSnapshot(function(snap){
      var arr = [];
      snap.forEach(function(d){ arr.push(d.data()); });
      handlers.clubRosters(arr);
    }, onErr));
    unsub.push(db.collection('settings').doc('config').onSnapshot(function(doc){
      handlers.settings(doc.exists ? doc.data() : null);
    }, onErr));
    return function stopAll(){ unsub.forEach(function(u){ u(); }); };
  }

  /* ---------------- 差異比對 + 批次寫入 ----------------
     app.js 沿用「先直接修改本地 STATE，再呼叫一次『儲存』」的既有寫法（原本是整份
     HTML 覆蓋發佈，現在改成：比對這次修改前後 STATE 的差異，只把真的變動過的文件
     寫回 Firestore）。這樣原本 29 處呼叫「儲存」的地方完全不用個別修改。
     ------------------------------------------------------------------- */

  function diffArrayById(prevArr, nextArr){
    var prevById = {}; (prevArr || []).forEach(function(x){ prevById[x.id] = x; });
    var nextById = {}; (nextArr || []).forEach(function(x){ nextById[x.id] = x; });
    var puts = [], removedIds = [];
    (nextArr || []).forEach(function(x){
      var p = prevById[x.id];
      if (!p || JSON.stringify(p) !== JSON.stringify(x)) puts.push(x);
    });
    (prevArr || []).forEach(function(x){
      if (!nextById[x.id]) removedIds.push(x.id);
    });
    return { puts: puts, removedIds: removedIds };
  }

  function chunkArray(arr, size){
    var out = [];
    for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // Firestore 一個 batch 最多 500 個操作，這裡保守切到 400，避免剛好卡在邊界。
  function commitOps(ops){
    // 2026-09-28 新增診斷紀錄（回應「新增/匯入獎項後記錄仍然會消失」持續
    // 回報，且加了 app.js 那邊讀取端的診斷之後，使用者操作時完全沒有看到
    // 任何 [awards-sync] 訊息——代表問題很可能出在「寫入」這一步本身，
    // 從來沒有真的送到 Firestore，而不是寫入成功後又被覆蓋掉）：直接在
    // 寫入的入口／每個 batch 送出前後都印出訊息，這樣才能確認 commitDiff
    // 到底有沒有被呼叫、算出了幾個操作、batch.commit() 本身是成功還是
    // 失敗（連同完整錯誤物件，包含 code／message）。
    if (!ops.length){
      console.log('[awards-sync] commitOps：這次沒有任何欄位變動，不需要寫入 Firestore（noop）');
      return Promise.resolve({ noop: true });
    }
    console.log('[awards-sync] commitOps：準備寫入 ' + ops.length + ' 個操作', ops.map(function(op){
      return (op.type === 'delete' ? 'DELETE ' : 'SET ') + op.ref.path;
    }));
    var chunks = chunkArray(ops, 400);
    var p = Promise.resolve();
    chunks.forEach(function(c, chunkIdx){
      p = p.then(function(){
        var batch = db.batch();
        c.forEach(function(op){
          if (op.type === 'set') batch.set(op.ref, op.data);
          else if (op.type === 'delete') batch.delete(op.ref);
        });
        return batch.commit().then(function(res){
          console.log('[awards-sync] commitOps：第 ' + (chunkIdx + 1) + '/' + chunks.length + ' 批（' + c.length + ' 個操作）已成功寫入 Firestore 伺服器');
          return res;
        }).catch(function(err){
          console.error('[awards-sync] commitOps：第 ' + (chunkIdx + 1) + '/' + chunks.length + ' 批寫入失敗！code=' + (err && err.code) + ' message=' + (err && err.message), err);
          throw err;
        });
      });
    });
    return p;
  }

  // prev / next 都是 { records, studentRosters, clubRosters, settings } 形狀
  // （對應 STATE 裡對應的欄位，settings 是 {schoolName, currentSchoolYear,
  // schoolYears, subjects, teachers} 這幾個欄位組成的物件）。
  function commitDiff(prev, next){
    var ops = [];

    var recDiff = diffArrayById(prev.records, next.records);
    recDiff.puts.forEach(function(r){ ops.push({ ref: db.collection('records').doc(r.id), type: 'set', data: r }); });
    recDiff.removedIds.forEach(function(id){ ops.push({ ref: db.collection('records').doc(id), type: 'delete' }); });

    var rosterDiff = diffArrayById(prev.studentRosters, next.studentRosters);
    rosterDiff.puts.forEach(function(r){ ops.push({ ref: db.collection('studentRosters').doc(r.id), type: 'set', data: r }); });
    rosterDiff.removedIds.forEach(function(id){ ops.push({ ref: db.collection('studentRosters').doc(id), type: 'delete' }); });

    var clubDiff = diffArrayById(prev.clubRosters, next.clubRosters);
    clubDiff.puts.forEach(function(r){ ops.push({ ref: db.collection('clubRosters').doc(r.id), type: 'set', data: r }); });
    clubDiff.removedIds.forEach(function(id){ ops.push({ ref: db.collection('clubRosters').doc(id), type: 'delete' }); });

    var prevSettings = prev.settings || {};
    var nextSettings = next.settings || {};
    if (JSON.stringify(prevSettings) !== JSON.stringify(nextSettings)){
      ops.push({ ref: db.collection('settings').doc('config'), type: 'set', data: nextSettings });
    }

    return commitOps(ops);
  }

  window.fbApi = {
    ALLOWED_DOMAIN: ALLOWED_DOMAIN,
    signIn: signIn,
    signOut: signOutUser,
    onAuthChange: onAuthChange,
    adminLogin: adminLogin,
    adminLogout: adminLogout,
    startListening: startListening,
    commitDiff: commitDiff,
    currentUser: function(){ return auth.currentUser; }
  };
})();
