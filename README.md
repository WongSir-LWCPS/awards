# 學生獲獎紀錄系統 — GitHub + Firebase 版本

這個資料夾是原本 Claude Artifact 版本系統的獨立版：網頁放 GitHub（或任何靜態網站
託管），資料放 Firebase（Firestore 資料庫 + Google 帳號登入），不再依賴
claude.ai。

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html` | 正式使用的網頁（老師/管理員平常打開的頁面） |
| `app.js` | 主要程式邏輯（從原本的 app.js 改寫，畫面/操作方式幾乎完全不變） |
| `style.css` | 樣式（原本的 `#app-style` 內容） |
| `firebase-config.js` | **要填上你自己 Firebase 專案的設定值**（見下面步驟） |
| `firebase-init.js` | 串接 Firebase（登入、Firestore 即時同步、儲存邏輯），一般不需要修改 |
| `firestore.rules` | Firestore 安全規則，要貼到 Firebase 主控台發佈 |
| `migrate.html` + `seed-data.json` | **一次性**的資料搬移工具，把舊系統最後的
  163 筆記錄／1228 筆學生名單／777 筆課外活動名單寫進 Firestore；資料搬完、系統
  正式上線後可以整個刪掉這兩個檔案，不影響已經寫入的資料 |

## 部署步驟

### 1. 建立 Firebase 專案（如果還沒做）

1. 打開 [console.firebase.google.com](https://console.firebase.google.com)，建立新專案（免費方案即可，不用開
   Google Analytics）。
2. 左側「Firestore Database」→「建立資料庫」→ 位置選 `asia-east1`（台灣，這個選了
   之後不能改）→ 規則先選「正式環境模式」。
3. 左側「Authentication」→「開始使用」→「Sign-in method」分頁 → 啟用「Google」。
4. 左側齒輪「專案設定」→ 往下捲到「你的應用程式」→ 按網頁圖示 `</>` 註冊一個網頁
   應用程式（不用勾 Firebase Hosting）→ 複製拿到的 `firebaseConfig` 物件。

### 2. 填入設定

打開 `firebase-config.js`，把裡面六個 `"貼上你的 ..."` 換成上一步拿到的實際值。

### 3. 發佈 Firestore 安全規則

Firebase 主控台 →「Firestore Database」→「規則」分頁 → 把 `firestore.rules` 的
完整內容貼上去 → 按「發佈」。

規則裡的管理員密碼目前是 `535800`（跟舊系統一樣）；之後要換密碼，直接改
`firestore.rules` 裡 `ADMIN_PASSWORD()` 那一行、重新貼上發佈即可，不需要改任何
其他檔案。

### 4. 搬移現有資料（只需要做一次）

先把整個資料夾（含 `migrate.html`、`seed-data.json`）放到一個網址可以打開的地方
（本機的簡易伺服器、或先推上 GitHub Pages 都可以——**不能直接雙擊 `index.html`／
`migrate.html` 用 `file://` 打開**，Google 登入視窗在 `file://` 底下常常無法正常
運作；本機測試最簡單的方法是在這個資料夾開終端機執行：

```
python3 -m http.server 8000
```

然後瀏覽器打開 `http://localhost:8000/migrate.html`）。

打開 `migrate.html`，照畫面上的三步驟（登入 → 輸入管理員密碼 → 按「開始匯入」）
執行一次。這個工具可以安全重複執行、不會刪除任何已有資料。

### 5. 推上 GitHub

在你的 GitHub 帳號開一個新的 repository（public 或 private 都可以），把這個資料夾
所有檔案 push 上去，然後到 repository 的 Settings → Pages，把來源設成
`main` 分支的根目錄，儲存後 GitHub 會給你一個網址（通常是
`https://你的帳號.github.io/repository名稱/`）。

### 6. 把 GitHub Pages 網址加進 Firebase 允許清單

Firebase 主控台 →「Authentication」→「Settings」分頁 →「Authorized domains」，
把上一步拿到的 GitHub Pages 網域（例如 `你的帳號.github.io`）加進去——不加的話
Google 登入會失敗。

完成以上六步，把 GitHub Pages 網址分享給其他老師（記得也要幫他們把 Google 帳號
加進學校的 `@lwcps.edu.hk` 網域裡，這樣他們登入時才會被允許），就可以正式使用了。

### 之後要更新網頁程式碼

之後如果我（或你自己）要修改 `app.js`／`style.css`／`index.html`，直接把改好的
檔案 push 到同一個 GitHub repository，GitHub Pages 會在幾十秒內自動更新，不需要
額外操作。

## 跟舊版（Claude Artifact）系統的差異

- 儲存方式：原本是整份網頁覆蓋發佈，現在是即時寫入 Firestore（逐筆記錄），其他人
  也會即時看到更新，不需要重新整理。
- 存取權限：現在需要用 `@lwcps.edu.hk` 的 Google 帳號登入才能打開頁面；管理員功能
  （學生名單/教師名單/課外活動名單/設定與匯出）額外需要管理員密碼，登入一次後
  不需要每次操作都重新輸入。
- 「下載範本」「匯出資料」：原本用 Claude Artifact 的下載能力，現在改用瀏覽器標準
  下載方式，使用體驗一樣（按下按鈕、瀏覽器下載 CSV 檔案），不需要額外設定。

## 已知限制 / 之後可以再討論的地方

- 沒有做本機端對端測試（這個工作環境目前連不上套件庫，沒辦法裝 Firebase 模擬器做
  完整測試），程式碼是照 Firebase 官方標準寫法仔細寫的，但第一次用你的真實 Firebase
  專案跑起來時，還是可能會遇到需要微調的地方，發現問題請直接告訴我。
- 管理員登入狀態目前不會自動過期（只有按「登出」才會清除），如果覺得需要自動
  逾時登出，之後可以再加。
