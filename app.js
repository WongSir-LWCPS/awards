(function(){
'use strict';

// 2026-09-21 GitHub + Firebase 版本：管理員密碼不再寫在這裡（也不需要在前端比對）——
// 密碼只存在 Firestore 規則裡，attemptLogin() 直接把使用者輸入的密碼交給
// fbApi.adminLogin() 送去給 Firestore 核對，成功/失敗由那次寫入請求本身決定。

/* ============================================================
   Utilities
   ============================================================ */

function tag(open, name, attrs){
  // Builds an open or close HTML tag string at runtime. Deliberately
  // built via concatenation: this source text is re-embedded verbatim
  // inside a live <script> element, so it must never itself contain the
  // literal close-tag sequence for "script" or "style" (that would end
  // the element early when the browser re-parses the page).
  return '<' + (open ? '' : '/') + name + (open && attrs ? ' ' + attrs : '') + '>';
}

function esc(s){
  s = (s === null || s === undefined) ? '' : String(s);
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escAttr(s){ return esc(s).replace(/\n/g,'&#10;'); }

// 說明圖示：把原本常駐顯示、教學性質的說明文字（欄位用法、匯入格式要求、設定頁各卡片的功能
// 說明等）收進一個小「!」圖示，點擊才在原地彈出提示框，減少畫面上長期佔位的文字量（2026-09-19
// 新增，回應使用者「網頁內所有的說明都以感嘆號圖示表示，按下後才彈出說明」的要求）。`html`
// 參數是已經組好的說明內容（呼叫端自行負責用 esc()／escAttr() 處理需要跳脫的部分，允許內含
// 少量強調用的 <b> 標籤，比照既有幾處說明文字原本的寫法）。**刻意不使用**在需要使用者立即
// 看到的地方：確認/警示彈窗內的關鍵資訊（例如「將刪除 X 筆記錄」「此操作無法復原」）、與動態
// 統計/篩選結果文字（例如「顯示 X / Y 項活動」）——這些必須維持原本常駐顯示，不應該讓使用者
// 多點一下才看得到。開合邏輯見事件委派區塊的 `toggle-hint`，與既有 `.ms-panel` 下拉面板共用
// 同一套「點擊面板外自動關閉」的機制（見該區塊開頭的通用判斷）。
function hintIcon(html){
  return '<span class="hint-wrap">' +
    '<button type="button" class="hint-icon" data-action="toggle-hint" aria-haspopup="true" aria-expanded="false" title="說明">!</button>' +
    '<div class="hint-panel" hidden>' + html + '</div>' +
  '</span>';
}

function csvEscape(v){
  v = (v === null || v === undefined) ? '' : String(v);
  if (/[",\r\n]/.test(v)) v = '"' + v.replace(/"/g,'""') + '"';
  return v;
}

// 比賽編號／獎項編號的顯示格式（2026-09-08 第五次修訂，回應「比賽編號和項目編號應該使用不同格式，
// 以免混亂」的要求；2026-09-08 第六次修訂，回應「現在的項目編號無法分辨是那一個比賽或科目」的
// 要求）：record.seq／award.seq 都是各自從 1 開始、獨立遞增的整數（見下方 backfillSeqNumbers
// 說明），單純顯示裸數字容易讓人誤以為兩者是同一件事、或看錯欄位；而獎項編號原本只顯示自己的號碼，
// 脫離畫面上下文（例如只看到一句「P020」）就完全看不出它屬於哪一場比賽、哪一個科目。
// formatRecordSeq() 在比賽編號前面加上字母前綴＋補零（C＝Competition）；formatAwardSeq() 除了
// 同樣加上字母前綴（P＝Prize）之外，**現在還會把它所屬記錄的比賽編號一併組進字串前半段**（例如
// 「C011-P020」），讓人只看這一串字就知道「這是 C011 這場比賽底下的 P020 號獎項」——科目本身沒有
// 直接編碼進字串（科目是中文名稱，不像比賽/獎項是整數，硬要壓成字母代碼可讀性反而更差），但因為
// 每場比賽只屬於一個科目，透過比賽編號就能回頭查到對應科目（畫面上比賽編號旁本來就會顯示科目；
// CSV 匯出的「科目」欄也是獨立一欄，同一列本來就看得到）。**底層儲存的 record.seq／award.seq
// 本身仍然是純整數，完全沒有變**——`backfillSeqNumbers()` 的推算、比大小、判斷是否重複，以及
// `readAwardsFromForm` 讀回表單隱藏欄位，用的都還是純數字；複合前綴只在「顯示／匯出」這一層才
// 組出來，never 存進 STATE。`formatAwardSeq` 的第二個參數（`recSeq`）在拿不到所屬記錄的編號時
// （理論上不會發生，但保留防呆）會退回單純的「P020」格式，不會整串留空。補零到 3 位純粹是目前
// 資料量（163／471）下讓數字對齊好讀，超過 999 也不會出錯，只是變成 4 位數字。
function formatRecordSeq(seq){ return (typeof seq === 'number') ? 'C' + String(seq).padStart(3, '0') : ''; }
function formatAwardSeq(seq, recSeq){
  if (typeof seq !== 'number') return '';
  var awardPart = 'P' + String(seq).padStart(3, '0');
  var recPart = formatRecordSeq(recSeq);
  return recPart ? (recPart + '-' + awardPart) : awardPart;
}

function uid(prefix){ return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8); }

function todayISO(){
  var d = new Date();
  var m = String(d.getMonth()+1).padStart(2,'0');
  var day = String(d.getDate()).padStart(2,'0');
  return d.getFullYear() + '-' + m + '-' + day;
}

function debounce(fn, ms){
  var t;
  return function(){
    var args = arguments, ctx = this;
    clearTimeout(t);
    t = setTimeout(function(){ fn.apply(ctx, args); }, ms);
  };
}

function displayDate(s){ return s ? s : '未填寫'; }

// 「比賽日期」欄位是自由輸入的文字，舊資料中存在不少非標準格式（例如「4月」
// 「12月13日」「26-4-2026」「28/11/2025至30/11/2025」等），無法保證都是
// YYYY-MM-DD。這裡盡量從常見格式中辨識出月份（回傳 '01'..'12'），辨識不到就
// 回傳 null——用於「獲獎記錄」頁面的按月份篩選功能。辨識規則（依序嘗試）：
//   1. YYYY-MM(-DD) 標準格式
//   2. 中文「X月」（如「4月」「12月13日」），取第一個出現的月份
//   3. D/M/YYYY 或 D-M-YYYY（含日期範圍如「28/11/2025至30/11/2025」，取第一
//      個日期），採香港慣用的「日/月/年」順序；如其中一個數字明顯不是合法月
//      份（>12），則採用另一個
// 仍無法判斷（例如空白，或兩個數字都超過 12 的「15，28-29/2026」）則回傳
// null，該記錄在選擇特定月份時會被視為「無法辨識」而不顯示。
function extractMonthFromDate(s){
  if (!s) return null;
  s = String(s).trim();
  if (!s) return null;

  var m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?/);
  if (m) {
    var mm1 = parseInt(m[2], 10);
    if (mm1 >= 1 && mm1 <= 12) return String(mm1).padStart(2, '0');
  }

  m = s.match(/(\d{1,2})月/);
  if (m) {
    var mm2 = parseInt(m[1], 10);
    if (mm2 >= 1 && mm2 <= 12) return String(mm2).padStart(2, '0');
  }

  m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    var month = null;
    if (b >= 1 && b <= 12) month = b;
    else if (a >= 1 && a <= 12) month = a;
    if (month !== null) return String(month).padStart(2, '0');
  }

  return null;
}

function recipientCount(rec){
  var n = 0;
  (rec.awards||[]).forEach(function(a){ n += (a.recipients||[]).length; });
  return n;
}
function awardCount(rec){ return (rec.awards||[]).length; }

// A record's 負責老師 field is stored as one string, one name per line (so
// existing search/export/CSV logic that predates the multi-select UI keeps
// working unchanged). This is the single shared splitter for that format —
// used by the 按教師 dropdown/filter, the stats breakdown, and the add/edit
// form's teacher checkboxes.
// Historical 負責老師 text was typed freely before this field had any
// structure, so more than one name sometimes ended up joined with 頓號/逗號
// instead of a newline, occasionally with a trailing "老師"/"主任" title, or
// with a stray space glued into an all-Chinese name. Parsing is lenient
// about all of that so 按教師 filtering/stats/CSV group by the actual
// individual teacher; what a NEW selection saves (readTeacherFromForm) is
// still always '\n'-joined clean names, so this leniency only matters when
// reading older free text.
function normalizeTeacherName(t){
  t = (t || '').trim();
  if (!t) return '';
  // Trust a fragment that already matches the settings-managed list exactly
  // as written - e.g. "科任老師" is a deliberate generic placeholder (not a
  // real person's name with a "老師" title stuck on the end), so it must
  // never be mangled by the fallback stripping below.
  if ((STATE.teachers || []).indexOf(t) !== -1) return t;
  var stripped = t.replace(/(老師|主任)$/, '').trim();
  if (/^[\u4e00-\u9fff\s]+$/.test(stripped)) stripped = stripped.replace(/\s+/g, '');
  return stripped || t;
}
function splitTeacherNames(str){
  return (str || '').split(/[、,，\n]+/).map(normalizeTeacherName).filter(Boolean);
}

/* ============================================================
   資料品質檢查（2026-09-20 新增，2026-09-21 改為只掃描「目前選定學年」：
   把先前每次都要在對話裡手動掃描/比對的資料清理流程，做成設定頁裡可自行
   重複執行的內建工具，見「資料品質檢查」一節）。三項掃描函式都吃一個
   year 參數，只針對該學年的記錄計算，避免一次列出全部學年、多學年資料
   混在一起不好看；呼叫端一律傳入 ui.selectedYear（設定頁頂端「學年」
   下拉選單目前選到的那個學年，跟其他設定頁小節如統計、課外活動名單一致）。
   都是唯讀計算，直接從目前的 STATE 即時算出，不需要另外按「掃描」按鈕、
   也不需要任何新的持久化欄位。
   ============================================================ */

// 只給「負責老師合併掃描」使用的較寬鬆拆分：在 splitTeacherNames 既有的
// 、,，\n 之外，額外支援「；」「及」「和」「與」，找不到任何分隔符號時才
// 退回以空白斷詞；稱謂後綴也多處理「先生」「小姐」兩種（splitTeacherNames
// 背後的 normalizeTeacherName 只處理「老師」「主任」，維持既有行為不變，
// 這裡另外寫一份，避免影響既有到處都在用的 splitTeacherNames／
// normalizeTeacherName）。對照 2026-09-19 第十一次更新「Task 2」一節記載
// 的手動掃描邏輯。
function stripTeacherHonorific(t){
  t = (t || '').trim();
  if (!t) return '';
  if ((STATE.teachers || []).indexOf(t) !== -1) return t;
  var stripped = t.replace(/(老師|主任|先生|小姐)$/, '').trim();
  if (/^[一-鿿\s]+$/.test(stripped)) stripped = stripped.replace(/\s+/g, '');
  return stripped || t;
}
function splitTeacherLineForScan(line){
  var parts = line.split(/[、,，;；]+|及|和|與/).map(function(s){ return s.trim(); }).filter(Boolean);
  if (parts.length < 2) parts = line.split(/\s+/).map(function(s){ return s.trim(); }).filter(Boolean);
  return parts.map(stripTeacherHonorific).filter(Boolean);
}

// 掃描指定學年裡，「負責老師」欄位仍是「單行合併多位老師」（而非一行一位
// 老師的既定格式）的可疑記錄：該行本身不等於教師名單裡任何一個完整姓名，
// 但依分隔符號拆開、去除稱謂後綴後，拆出的片段 100% 都能在教師名單裡找到
// 對應項目，才視為高信心度的可疑合併行（與人工核對過的門檻一致，避免誤判
// 單純的長姓名或非教師相關文字）。回傳陣列，每筆
// { id, event, schoolYear, original, suggested }——suggested 是把可疑行
// 展開成多行、其餘本來就正確的行原樣保留後的完整建議值；沒有任何一行需要
// 展開的記錄不會出現在結果裡。
function scanTeacherMerges(year){
  var teacherSet = {};
  (STATE.teachers || []).forEach(function(t){ teacherSet[t] = true; });
  var out = [];
  recordsForYear(year).forEach(function(rec){
    var raw = rec.teacher || '';
    if (!raw.trim()) return;
    var lines = raw.split('\n').map(function(s){ return s.trim(); }).filter(Boolean);
    var changed = false;
    var newLines = [];
    lines.forEach(function(line){
      if (teacherSet[line]){ newLines.push(line); return; }
      var candidates = splitTeacherLineForScan(line);
      if (candidates.length >= 2 && candidates.every(function(c){ return teacherSet[c]; })){
        newLines = newLines.concat(candidates);
        changed = true;
      } else {
        newLines.push(line);
      }
    });
    if (changed){
      out.push({ id: rec.id, event: rec.event, schoolYear: rec.schoolYear, original: raw, suggested: newLines.join('\n') });
    }
  });
  return out;
}

// 掃描指定學年裡「比賽日期」欄位格式異常（非空白、但不是標準 YYYY-MM-DD）
// 的記錄。只有能明確辨識成「YYYY/M/D」或「YYYY.M.D」這類無歧義寫法時，
// 才算出建議的標準化值（suggested）；其餘格式（中文日期、缺年份、順序
// 不明等）系統無法安全猜測，suggested 留空字串，只能交由管理員自行判斷、
// 按「前往編輯」手動修正——沿用系統一貫「寧缺勿猜」的保守慣例。
function scanDateFormats(year){
  var out = [];
  recordsForYear(year).forEach(function(rec){
    var raw = (rec.date || '').trim();
    if (!raw) return;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return;
    var suggested = '';
    var m = raw.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/);
    if (m){
      var mm = ('0' + m[2]).slice(-2), dd = ('0' + m[3]).slice(-2);
      suggested = m[1] + '-' + mm + '-' + dd;
    }
    out.push({ id: rec.id, event: rec.event, schoolYear: rec.schoolYear, original: raw, suggested: suggested });
  });
  return out;
}

// 掃描指定學年裡「個人」／「團體」類型獎項裡得獎人姓名本身可疑的項目：
// 姓名空白、整段疑似英文（無法與中文學生名單比對）、或疑似是團體代稱而非
// 個別學生姓名（例如「全體男子跳繩隊員」）。純粹是啟發式判斷，只列出來讓
// 管理員自行複核，系統無法安全地自動猜測正確姓名，因此這項檢查沒有
// 「建議修正」可套用（不同於上面兩項）。
var DQ_GROUP_NAME_HINTS = ['隊員', '全體', '全班', '代表隊'];
function scanSuspiciousRecipientNames(year){
  var out = [];
  recordsForYear(year).forEach(function(rec){
    (rec.awards || []).forEach(function(a){
      if (a.type !== 'individual' && a.type !== 'team') return;
      (a.recipients || []).forEach(function(rp){
        var name = (rp.name || '').trim();
        var reason = '';
        if (!name) reason = '姓名空白';
        else if (/^[A-Za-z .'-]+$/.test(name)) reason = '疑似英文姓名';
        else if (DQ_GROUP_NAME_HINTS.some(function(k){ return name.indexOf(k) !== -1; })) reason = '疑似團體代稱（非個別學生姓名）';
        if (reason){
          out.push({ id: rec.id, event: rec.event, schoolYear: rec.schoolYear, awardName: a.name, name: name || '（空白）', reason: reason });
        }
      });
    });
  });
  return out;
}

function totalRecipientCount(records){
  var n = 0; records.forEach(function(r){ n += recipientCount(r); }); return n;
}
function totalAwardCount(records){
  var n = 0; records.forEach(function(r){ n += awardCount(r); }); return n;
}

function safeSessionGet(key){
  try{ return sessionStorage.getItem(key); }catch(e){ return null; }
}
function safeSessionSet(key, val){
  try{ sessionStorage.setItem(key, val); }catch(e){}
}
function safeSessionRemove(key){
  try{ sessionStorage.removeItem(key); }catch(e){}
}

// Which nav tab was showing, kept in sessionStorage (like awardsAdminMode)
// so it survives the automatic page reload that follows every successful
// artifact.publish() in saveAndPublish(). Without this, `ui` — never
// published, reset from scratch on every reload — always came back with
// its hardcoded initial view ('add'), so ANY save made anywhere in the
// app (including on the settings page, which saves on almost every
// action) bounced the admin back to "新增記錄" instead of leaving them
// where they were. Fixed 2026-09-19; see the Project doc for the report
// this addressed ("設定頁面經常會跳到新增記錄頁面").
var VALID_VIEWS = { add:true, list:true, students:true, stats:true, settings:true };
function setView(v){
  ui.view = v;
  if (VALID_VIEWS[v]) safeSessionSet('awardsView', v);
}

/* ============================================================
   State load + defensive migration
   ------------------------------------------------------------
   2026-09-21 GitHub + Firebase 版本：STATE 不再從頁面裡的 <script id="state-data">
   同步讀出（那是 Claude Artifact 版本的做法），改成等 Firebase 那邊（Google 登入 +
   Firestore 四個來源：records / studentRosters / clubRosters / settings）第一次把
   資料送回來之後才組出來——所以這裡先只宣告 STATE = null，實際賦值移到檔案最後面的
   「Firebase bootstrap」那一段。render() 等函式在 STATE 還是 null 的時候不會被呼叫
   （見 bootstrap 段落的登入畫面/載入畫面邏輯）。

   migrateState(raw) 把底下這些既有的防呆/搬移邏輯全部原封不動保留，只是包成一個函式，
   在資料第一次完整到齊時呼叫一次。
   ============================================================ */

var STATE = null;

function migrateState(STATE){
if (!STATE.meta) STATE.meta = { schoolName:'學校', currentSchoolYear:'' };
if (!Array.isArray(STATE.schoolYears) || !STATE.schoolYears.length){
  STATE.schoolYears = STATE.meta.currentSchoolYear ? [STATE.meta.currentSchoolYear] : ['本學年'];
}
if (!STATE.meta.currentSchoolYear) STATE.meta.currentSchoolYear = STATE.schoolYears[STATE.schoolYears.length-1];
if (!Array.isArray(STATE.subjects)) STATE.subjects = [];
if (!Array.isArray(STATE.records)) STATE.records = [];
if (!Array.isArray(STATE.studentRosters)) STATE.studentRosters = [];
if (!Array.isArray(STATE.clubRosters)) STATE.clubRosters = [];
if (!Array.isArray(STATE.teachers)){
  // First time this field exists: seed it from every distinct name already
  // typed into some record's 負責老師 field, so the admin isn't starting
  // the new dropdown-managed list from empty. Purely a one-off migration —
  // after this, STATE.teachers is edited only via 設定頁「教師名單」.
  var seedTeacherSet = {};
  STATE.records.forEach(function(rec){
    splitTeacherNames(rec.teacher).forEach(function(t){ seedTeacherSet[t] = true; });
  });
  STATE.teachers = Object.keys(seedTeacherSet).sort(function(a,b){ return a.localeCompare(b, 'zh-Hant'); });
}
// Always keep the list sorted, even when it was loaded (not freshly seeded)
// from a state file that was hand-edited outside the settings-page form.
STATE.teachers.sort(function(a,b){ return a.localeCompare(b, 'zh-Hant'); });
STATE.studentRosters.forEach(function(r){
  if (r.studentNo === undefined) r.studentNo = '';
  if (r.gender === undefined) r.gender = '';
  if (r.dob === undefined) r.dob = '';
});
// Upgrade any record still using the old flat "recipients" shape (from an
// earlier version of this page) into the award-grouped shape.
STATE.records.forEach(function(rec){
  if (!Array.isArray(rec.awards)){
    var groups = [], byName = {};
    (rec.recipients || []).forEach(function(rp){
      var name = (rp.award || rec.award || '').trim();
      if (!byName[name]){ byName[name] = { id: uid('a'), name: name, recipients: [] }; groups.push(byName[name]); }
      byName[name].recipients.push({ class: rp.class || '', no: rp.no || '', name: rp.name || '' });
    });
    if (!groups.length) groups.push({ id: uid('a'), name: rec.award || '', recipients: [] });
    rec.awards = groups;
    delete rec.recipients;
    delete rec.award;
  }
  if (!rec.schoolYear) rec.schoolYear = STATE.meta.currentSchoolYear;
  // Backfill the roll-number field (班內學號, "no") on any recipient created
  // before it existed. studentNo (the school-wide permanent ID, used for
  // cross-year identity matching — see "Student rosters" section below) is a
  // separate, later-added field; it is backfilled the same way here for any
  // recipient that predates it, but its actual VALUE is only ever computed
  // by attachStudentNos() at save time (see commitRecordFromForm), never
  // guessed during this load-time migration.
  (rec.awards || []).forEach(function(a){
    (a.recipients || []).forEach(function(rp){
      if (rp.no === undefined) rp.no = '';
      if (rp.studentNo === undefined) rp.studentNo = '';
    });
    // Backfill 個人/團體 (individual/team) on any award created before this
    // field existed. There is no way to infer this from the old data — a
    // multi-recipient award could equally be several individual winners of
    // the same-named prize, or one team — so every pre-existing award
    // defaults to 'individual' and an admin can correct specific ones via
    // edit. This is a documented, deliberate simplification, not a guess
    // the system claims confidence in.
    if (a.type !== 'individual' && a.type !== 'team' && a.type !== 'school' && a.type !== 'teacher') a.type = 'individual';
    // 項目（如「高小組60米賽跑」）是獎項名稱之下的自由文字子分類，比很多既有獎項
    // 都晚加入——本身就允許留空（有些比賽根本沒有分項目），所以留空是一個
    // 正常、永久的值，不只是遷移時的暫時佔位。
    if (typeof a.item !== 'string') a.item = '';
  });
});

// 比賽編號／獎項編號（2026-09-06 第三次修訂，回應「每個比賽及每個項目都應該有獨立編號，
// 以便匯出後能更輕易分辨那些項目是相同的獎項」的要求；2026-09-07 第四次修訂，回應
// 「比賽編號及項目編號不能重複」的要求，補上「發現重複編號時自動修復」的保護）：
// 每筆記錄（比賽）與每個獎項各自有一個穩定、人類可讀、全域唯一的整數編號
// （record.seq／award.seq），純粹方便管理員在匯出後用編號分辨「哪幾行其實是同一個
// 獎項」——與內部的 uid() 字串（record.id／award.id，只用作 DOM/state 內部識別、
// 從未打算給人看）是兩回事。每次載入都會重新從資料本身推算，而不是隨意相信之前存下來
// 的計數器：先按陣列既有順序（即原始建立/匯入順序）掃描一次——如果同一個編號出現超過
// 一次（例如兩個不同管理員分頭在各自分頁新增記錄、剛好分配到同一個編號，而這兩筆記錄
// 後來又都保留在同一份資料裡），只保留「第一個」用到這個編號的記錄/獎項，其餘重複的
// 視為未編號；然後再把所有未編號（原本就缺編號，或剛被判定重複而拿掉編號）的記錄/獎項
// 依陣列順序往後依序補上全新編號。之後新建立的記錄/獎項編號只會繼續往後遞增，既有編號
// 一經指派原則上永久不變（即使之後編輯內容、甚至改變陣列順序也不會重新分配）——但如果
// 發現與別的記錄/獎項編號重複，「後出現」的那個一定會被重新分配一個新編號，確保任何時候
// 都不會有兩筆記錄或兩個獎項共用同一個編號。
// 2026-09-21：在 Firebase 版本裡，這段只會在「第一次把資料從 Firestore 完整讀回來」
// 時跑一次（見檔案最後 Firebase bootstrap 段落），之後個別文件的即時更新不會重跑這段，
// 避免正常使用時（例如兩個人前後腳個別存檔）被誤判成「編號重複」而不必要地重新分配。
(function backfillSeqNumbers(){
  var seenRecordSeq = {};
  var maxRecordSeq = 0;
  STATE.records.forEach(function(rec){
    if (typeof rec.seq === 'number'){
      if (seenRecordSeq[rec.seq]){
        delete rec.seq; // 編號重複：拿掉編號，交給下面當成「未編號」重新分配
      } else {
        seenRecordSeq[rec.seq] = true;
        if (rec.seq > maxRecordSeq) maxRecordSeq = rec.seq;
      }
    }
  });
  var nextRecordSeq = maxRecordSeq + 1;
  STATE.records.forEach(function(rec){
    if (typeof rec.seq !== 'number'){ rec.seq = nextRecordSeq; nextRecordSeq += 1; }
  });
  STATE.nextSeq = nextRecordSeq;

  var seenAwardSeq = {};
  var maxAwardSeq = 0;
  STATE.records.forEach(function(rec){
    (rec.awards || []).forEach(function(a){
      if (typeof a.seq === 'number'){
        if (seenAwardSeq[a.seq]){
          delete a.seq; // 編號重複：拿掉編號，交給下面當成「未編號」重新分配
        } else {
          seenAwardSeq[a.seq] = true;
          if (a.seq > maxAwardSeq) maxAwardSeq = a.seq;
        }
      }
    });
  });
  var nextAwardSeq = maxAwardSeq + 1;
  STATE.records.forEach(function(rec){
    (rec.awards || []).forEach(function(a){
      if (typeof a.seq !== 'number'){ a.seq = nextAwardSeq; nextAwardSeq += 1; }
    });
  });
  STATE.nextAwardSeq = nextAwardSeq;
})();

return STATE;
}

/* ============================================================
   UI (per-viewer, never published)
   ============================================================ */

var ui = {
  view: (VALID_VIEWS[safeSessionGet('awardsView')] ? safeSessionGet('awardsView') : 'add'),
  adminMode: safeSessionGet('awardsAdminMode') === '1',
  // 2026-09-21 Firebase 版本：STATE 這時候還是 null（要等 Firebase 資料回來才有），
  // 不能在這裡讀 STATE.meta，先留空字串，等 maybeStartApp() 拿到真正資料時
  // 會設定成正確的值（見檔案最後 Firebase bootstrap 段落）。
  selectedYear: '',
  editingId: null,
  listSearch: '',
  listSubject: 'all',
  listMonth: 'all', // 獲獎記錄列表的月份篩選：'all' 或 '01'..'12'
  listOnlyReview: false,
  listGroupBy: 'subject', // 'subject' | 'student' | 'teacher'
  listTeacherFilter: '', // 按教師: must pick a teacher from the dropdown before records show
  listStudentClass: '', // 按學生: class dropdown (must be picked before the name dropdown populates)
  listStudentName: '', // 按學生: name dropdown, scoped to listStudentClass
  expandedId: null,
  deleteConfirmId: null,
  saving: false,
  syncOK: null,
  modal: null, // {type:'login'} | {type:'import', groups:[...], fileName}
  studentSearch: '',
  rosterYear: null, // defaults to selectedYear when first opened
  rosterPage: 1, // 學生名單管理表格的分頁頁碼（1-based），見 ROSTER_PAGE_SIZE／renderRosterSection
  rosterDeleteConfirmId: null,
  clubRosterYear: null, // defaults to selectedYear when first opened
  clubRosterDeleteConfirmId: null,
  clubFilterQuery: '',
  clubRosterSelectedClub: '', // gates the settings-page roster table: empty means
    // "nothing chosen yet", so hundreds of members across every club aren't all
    // dumped onto the screen at once (see renderClubRosterTableBody)
};

var GATED_VIEWS = { stats:true, settings:true, students:true };

var root = document.getElementById('app-root');

/* ============================================================
   Derived / stats helpers
   ============================================================ */

function recordsForYear(year){
  return STATE.records.filter(function(r){ return r.schoolYear === year; });
}

function computeStats(records){
  var perSubjectRecipients = {}, perSubjectAwards = {}, perClass = {}, perStudent = {}, perTeacher = {};
  var perTypeAwards = { individual:0, team:0, school:0, teacher:0 }, perTypeRecipients = { individual:0, team:0, school:0, teacher:0 };
  STATE.subjects.forEach(function(s){ perSubjectRecipients[s] = 0; perSubjectAwards[s] = 0; });
  records.forEach(function(rec){
    perSubjectAwards[rec.subject] = (perSubjectAwards[rec.subject] || 0) + awardCount(rec);
    var teacherNames = splitTeacherNames(rec.teacher);
    teacherNames.forEach(function(t){ perTeacher[t] = (perTeacher[t] || 0) + 1; });
    (rec.awards||[]).forEach(function(a){
      var t = a.type === 'team' ? 'team' : (a.type === 'school' ? 'school' : (a.type === 'teacher' ? 'teacher' : 'individual'));
      perTypeAwards[t] += 1;
      (a.recipients||[]).forEach(function(rp){
        if (!rp.name) return;
        perSubjectRecipients[rec.subject] = (perSubjectRecipients[rec.subject] || 0) + 1;
        perTypeRecipients[t] += 1;
        // 「學校獎項」「教師獎項」的得獎人是校方本身或老師姓名，不是學生——
        // 不能混進「按班別」「按學生」排行，否則會出現一個假的「班別」（因為
        // rp.class 永遠是空字串，會被歸進「未填班別」）以及一個看起來像學生的
        // 假姓名。這兩類獎項的人次已經在上面 perTypeRecipients.school／
        // perTypeRecipients.teacher／perSubjectRecipients 記過帳，這裡到此為止。
        if (t === 'school' || t === 'teacher') return;
        var cls = (rp.class || '未填班別').trim() || '未填班別';
        perClass[cls] = (perClass[cls] || 0) + 1;
        var key = cls + '｜' + rp.name.trim();
        if (!perStudent[key]) perStudent[key] = { name: rp.name.trim(), cls: cls, count: 0 };
        perStudent[key].count += 1;
      });
    });
  });
  return {
    perSubjectRecipients:perSubjectRecipients, perSubjectAwards:perSubjectAwards, perClass:perClass,
    perStudent:perStudent, perTeacher:perTeacher, perTypeAwards:perTypeAwards, perTypeRecipients:perTypeRecipients
  };
}

function sortedEntries(obj, limit){
  var arr = Object.keys(obj).map(function(k){ return [k, obj[k]]; });
  arr.sort(function(a,b){ return b[1]-a[1]; });
  if (limit) arr = arr.slice(0, limit);
  return arr;
}

/* ============================================================
   Student rosters (per school year) + cross-year student history
   ------------------------------------------------------------
   Each roster row carries studentNo — the school's own student ID,
   entered as the primary key when importing/adding — which stays the
   same for one real student across school years even as class/no/name
   details change. When a roster row has a studentNo, it is the
   identity used to group that student's history.

   2026-09-19 第十二次更新以前，award records only ever stored a
   recipient's class/no/name (never studentNo — teachers logging an
   award do not look up the student ID), so matching an award record
   to a student identity could only be done by exact (trimmed) name
   match. **第十二次更新新增**：recipients now also carry a `studentNo`
   field (見 lookupStudentNo／attachStudentNos，下方緊接著)，
   在每次儲存記錄時用「班別＋姓名」（或退回純姓名）自動比對該學年的
   `studentRosters`，盡量幫「個人」／「團體」類型的得獎人補上
   studentNo。`studentHistory()`（下方）比對時，只要得獎人已有
   studentNo 就一律用 studentNo 精確比對，不再退回姓名——這樣兩位
   剛好同名、但各自有不同 studentNo 的學生不會再被誤判成同一人。
   只有在得獎人完全沒有（或比對不到）studentNo 時，才退回原本的
   純姓名比對（例如：這位得獎人在該學年名單裡找不到相符項目、或有
   多筆同班同名/同名而無法判斷是哪一位——見 lookupStudentNo「寧缺
   勿猜」的說明；又或者是 2026-08-31 匯入時就存在、早於任何名單的
   163 筆歷史記錄）——這是刻意保留、且已記錄在案的簡化，並非
   bug。「學校獎項」／「教師獎項」的得獎人不是學生，從不嘗試比對
   studentNo。
   ============================================================ */

function studentRosterForYear(year){
  return STATE.studentRosters.filter(function(r){ return r.schoolYear === year; });
}

// 依「班別＋姓名」比對 `year` 學年的學生名單，找出這位得獎人對應的
// studentNo（2026-09-19 第十二次更新新增，回應「學生名單及記錄應該以
// 學生編號作為跨學年配對」的要求）。班別＋姓名剛好命中一筆才採用；
// 命中不到（班別打錯/缺漏等常見情形）才退回純姓名比對，一樣要求剛好
// 命中一筆；找不到、或命中多筆（例如多位同班同名或同名學生，系統無法
// 判斷得獎的是哪一位）一律回傳空字串，不猜測——與系統一貫「先預覽、
// 寧缺勿猜」的保守慣例一致，交由 studentHistory() 的姓名 fallback
// 邏輯接手，而不是冒然配錯人。
function lookupStudentNo(year, cls, name){
  name = (name || '').trim();
  if (!name) return '';
  var roster = studentRosterForYear(year).filter(function(r){ return r.studentNo && r.name.trim() === name; });
  if (!roster.length) return '';
  var clsTrim = (cls || '').trim();
  var byClass = roster.filter(function(r){ return (r.class || '').trim() === clsTrim; });
  if (byClass.length === 1) return byClass[0].studentNo;
  if (roster.length === 1) return roster[0].studentNo;
  return '';
}

// 幫一份獎項陣列裡「個人」／「團體」類型的得獎人，逐一補上（或更新）
// studentNo——每次儲存記錄（新增/編輯）都會重新呼叫一次，確保用的
// 永遠是當下最新的名單資料比對結果，而不是凍結在第一次儲存當下的
// 舊值（例如名單事後修正了某位學生的班別，下次這筆記錄被開啟儲存時
// 也會一併更新）。「學校獎項」／「教師獎項」的得獎人不是學生，跳過
// 不比對，studentNo 維持原樣（'' 或不存在）。
function attachStudentNos(awards, year){
  awards.forEach(function(a){
    if (a.type === 'school' || a.type === 'teacher') return;
    a.recipients.forEach(function(rp){ rp.studentNo = lookupStudentNo(year, rp.class, rp.name); });
  });
}

// Classes with at least one roster entry for `year`, sorted. Backs the
// "從學生名單選取" recipient picker on the add/edit record form (see
// rosterPickerHTML/populateRosterPickerClasses below) — lets a teacher pick
// a class first, then tick multiple students in it, instead of typing each
// recipient row (班別/學號/姓名) by hand.
function rosterClassesForYear(year){
  var set = {};
  studentRosterForYear(year).forEach(function(r){
    var c = (r.class || '').trim();
    if (c) set[c] = true;
  });
  return Object.keys(set).sort();
}

// Roster rows for one class within `year`, sorted by class number
// (numeric-aware) then name, for display in the recipient picker.
function rosterStudentsForClass(year, cls){
  return studentRosterForYear(year)
    .filter(function(r){ return (r.class || '').trim() === cls; })
    .slice()
    .sort(function(a, b){
      var an = parseInt(a.no, 10), bn = parseInt(b.no, 10);
      if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn;
      return (a.no || '').localeCompare(b.no || '') || (a.name || '').localeCompare(b.name || '');
    });
}

// Club / extracurricular activity (課外活動) rosters, per school year —
// same idea as the student roster above but keyed by club name instead
// of class, backing the "從課外活動名單選取" recipient picker (see
// clubPickerHTML below) and the 設定頁「課外活動名單」management card.
function clubRosterForYear(year){
  return STATE.clubRosters.filter(function(r){ return r.schoolYear === year; });
}

function clubNamesForYear(year){
  var set = {};
  clubRosterForYear(year).forEach(function(r){
    var c = (r.club || '').trim();
    if (c) set[c] = true;
  });
  return Object.keys(set).sort(function(a,b){ return a.localeCompare(b, 'zh-Hant'); });
}

// Members of one club within `year`, sorted by class then class number
// (numeric-aware) then name — a club typically spans many classes at
// once (unlike the per-class student roster picker), so each member row
// needs to carry its own class along, not just its number.
function clubMembersForClub(year, club){
  return clubRosterForYear(year)
    .filter(function(r){ return (r.club || '').trim() === club; })
    .slice()
    .sort(function(a, b){
      if ((a.class||'') !== (b.class||'')) return (a.class||'').localeCompare(b.class||'');
      var an = parseInt(a.no, 10), bn = parseInt(b.no, 10);
      if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn;
      return (a.no || '').localeCompare(b.no || '') || (a.name || '').localeCompare(b.name || '');
    });
}

function sortedSchoolYears(){
  return STATE.schoolYears.slice().sort();
}

// Build the list of "student identities" matching a search query. Each
// identity is either { studentNo, names:[...] } (one or more roster rows
// sharing a studentNo, across any number of years) or { studentNo:null,
// names:[name] } (a plain name with no roster studentNo behind it, found
// either in a roster row entered without a studentNo, or only in award
// records).
function studentIdentities(query){
  query = (query || '').trim().toLowerCase();
  if (!query) return [];

  var byStudentNo = {};
  var namesWithoutPK = {};
  STATE.studentRosters.forEach(function(r){
    var name = (r.name || '').trim();
    if (!name) return;
    var hit = (r.studentNo && r.studentNo.toLowerCase().indexOf(query) !== -1) ||
              name.toLowerCase().indexOf(query) !== -1;
    if (!hit) return;
    if (r.studentNo){
      if (!byStudentNo[r.studentNo]) byStudentNo[r.studentNo] = {};
      byStudentNo[r.studentNo][name] = true;
    } else {
      namesWithoutPK[name] = true;
    }
  });

  var recordNames = {};
  STATE.records.forEach(function(rec){
    (rec.awards || []).forEach(function(a){
      (a.recipients || []).forEach(function(rp){
        var name = (rp.name || '').trim();
        if (name && name.toLowerCase().indexOf(query) !== -1) recordNames[name] = true;
      });
    });
  });

  var coveredNames = {};
  var identities = Object.keys(byStudentNo).sort().map(function(sn){
    var names = Object.keys(byStudentNo[sn]);
    names.forEach(function(n){ coveredNames[n] = true; });
    return { studentNo: sn, names: names };
  });

  var otherNames = {};
  Object.keys(namesWithoutPK).forEach(function(n){ if (!coveredNames[n]) otherNames[n] = true; });
  Object.keys(recordNames).forEach(function(n){ if (!coveredNames[n]) otherNames[n] = true; });
  Object.keys(otherNames).sort().forEach(function(n){ identities.push({ studentNo: null, names: [n] }); });

  return identities;
}

function studentHistory(identity){
  var names = identity.names;
  var roster = STATE.studentRosters
    .filter(function(r){
      return identity.studentNo ? r.studentNo === identity.studentNo
                                 : !r.studentNo && names.indexOf((r.name||'').trim()) !== -1;
    })
    .slice()
    .sort(function(a,b){ return (a.schoolYear||'').localeCompare(b.schoolYear||''); });
  var entries = [];
  STATE.records.forEach(function(rec){
    (rec.awards || []).forEach(function(a){
      (a.recipients || []).forEach(function(rp){
        // 得獎人若已有 studentNo（見 attachStudentNos），一律用 studentNo
        // 精確比對這個身分——即使姓名剛好也在 names 清單裡，只要 studentNo
        // 不相符就不算這個人（解決兩個不同學生剛好同名的誤判）。只有完全
        // 沒有 studentNo 的得獎人（名單裡找不到、或無法判斷是哪一位、或
        // 「學校獎項」／「教師獎項」這類本來就不比對的類型）才退回姓名
        // 比對，見上方「Student rosters」專節的完整說明。
        var matches = rp.studentNo
          ? rp.studentNo === identity.studentNo
          : names.indexOf((rp.name || '').trim()) !== -1;
        if (matches){
          entries.push({
            year: rec.schoolYear, date: rec.date, subject: rec.subject, event: rec.event,
            awardName: a.name, cls: rp.class, no: rp.no, recordId: rec.id
          });
        }
      });
    });
  });
  entries.sort(function(a,b){
    if (a.year !== b.year) return (b.year||'').localeCompare(a.year||'');
    return (b.date||'').localeCompare(a.date||'');
  });
  return { roster: roster, entries: entries };
}

/* ============================================================
   Toast
   ============================================================ */

function showToast(msg, timeout){
  var wrap = document.getElementById('toast-wrap');
  if (!wrap) return;
  var el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(function(){ el.remove(); }, timeout || 3200);
}

/* ============================================================
   Persistence: publish the whole page as the new version
   ============================================================ */

function buildFullHTML(state){
  var styleSrc = document.getElementById('app-style').textContent;
  var scriptSrc = document.getElementById('app-script').textContent;
  var stateJson = JSON.stringify(state).replace(/</g, '\\u003c');
  var head = [
    tag(true,'meta','charset="utf-8"'),
    tag(true,'meta','name="viewport" content="width=device-width, initial-scale=1"'),
    tag(true,'title') + esc('學生獲獎紀錄系統') + tag(false,'title'),
    tag(true,'link','rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+HK:wght@500;600;700&family=Noto+Sans+HK:wght@400;500;600;700&display=swap"'),
    tag(true,'script','src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"') + tag(false,'script'),
    tag(true,'style','id="app-style"') + styleSrc + tag(false,'style')
  ].join('\n');
  var body = [
    tag(true,'div','id="app-root"'),
    tag(false,'div'),
    tag(true,'script','id="state-data" type="application/json"') + stateJson + tag(false,'script'),
    tag(true,'script','id="app-script"') + scriptSrc + tag(false,'script')
  ].join('\n');
  return '<!doctype html>\n' + tag(true,'html','lang="zh-Hant"') + '\n' +
    tag(true,'head') + '\n' + head + '\n' + tag(false,'head') + '\n' +
    tag(true,'body') + '\n' + body + '\n' + tag(false,'body') + '\n' +
    tag(false,'html');
}

/* ============================================================
   2026-09-21 GitHub + Firebase 版本：儲存機制改用 Firestore
   ------------------------------------------------------------
   firestoreMirror 是「目前已知、跟 Firestore 同步的版本」，由 firebase-init.js 的
   onSnapshot 監聽持續更新（見檔案最後 Firebase bootstrap 段落）；STATE 是畫面實際
   在讀/寫的那一份，兩者平常是同一份資料，只有在「使用者剛修改完 STATE、還沒存檔」
   的短暫瞬間會不一樣。

   saveAndPublish() 沿用舊名稱與呼叫方式（全部 29 個呼叫點完全不用改），行為改成：
   把 STATE 現在的樣子跟 firestoreMirror 比對，只把真的變動過的記錄/名單/設定寫回
   Firestore（fbApi.commitDiff），success 之後把 firestoreMirror 同步更新成一樣的
   內容（避免等 onSnapshot 回音時被誤判成又有新差異）。不再需要「儲存後整頁重載」——
   畫面在呼叫這個函式之前，STATE 已經是新的內容，所以直接視覺上就是最新的；這裡主要
   是把差異寫回伺服器、讓其他人也看得到。
   ============================================================ */

var firestoreMirror = null; // {records, studentRosters, clubRosters, settings} — 見 bootstrap 段落

function stateToMirrorShape(s){
  return {
    records: s.records,
    studentRosters: s.studentRosters,
    clubRosters: s.clubRosters,
    settings: {
      schoolName: s.meta.schoolName,
      currentSchoolYear: s.meta.currentSchoolYear,
      schoolYears: s.schoolYears,
      subjects: s.subjects,
      teachers: s.teachers
    }
  };
}

function saveAndPublish(successMsg){
  if (!window.fbApi || !firestoreMirror){
    showToast('尚未連接資料庫，變更暫時只存在此頁面（重新整理會遺失）', 4200);
    return;
  }
  ui.saving = true;
  render();
  var nextMirror = stateToMirrorShape(STATE);
  window.fbApi.commitDiff(firestoreMirror, nextMirror).then(function(){
    firestoreMirror = JSON.parse(JSON.stringify(nextMirror));
    ui.saving = false;
    ui.syncOK = true;
    showToast(successMsg || '已儲存');
    render();
  }).catch(function(err){
    ui.saving = false;
    ui.syncOK = false;
    var code = err && err.code;
    if (code === 'permission-denied'){
      showToast('沒有權限完成這個操作（可能是管理員登入已失效，請重新輸入密碼再試一次）', 4200);
    } else {
      showToast('儲存失敗：' + (err && err.message ? err.message : '未知錯誤') + '，請檢查網路連線後重試', 4200);
    }
    render();
  });
}

/* ============================================================
   Record CRUD
   ============================================================ */

function getRecord(id){
  for (var i=0;i<STATE.records.length;i++) if (STATE.records[i].id === id) return STATE.records[i];
  return null;
}

function readAwardsFromForm(formEl){
  var awards = [];
  formEl.querySelectorAll('.award-block').forEach(function(block){
    var name = block.querySelector('.award-name').value.trim();
    var itemInput = block.querySelector('.award-item');
    var item = itemInput ? itemInput.value.trim() : '';
    var typeSelect = block.querySelector('.award-type');
    var typeVal = typeSelect ? typeSelect.value : 'individual';
    var type = typeVal === 'team' ? 'team' : (typeVal === 'teacher' ? 'teacher' : (typeVal === 'school' ? 'school' : 'individual'));
    var recipients = [];
    if (type === 'school'){
      // 「學校獎項」不渲染任何 recipient-row（見 awardBlockHTML 的 isSchool
      // 分支），得獎人固定是校方本身，這裡直接補一筆固定的得獎人資料，不用
      // 讀 DOM——DOM 上本來就沒有東西可讀。
      recipients.push({ class:'', no:'', name: STATE.meta.schoolName || '' });
    } else {
      block.querySelectorAll('.recipient-row').forEach(function(row){
        // 「教師獎項」的得獎人資料列（見 recipientRowHTML 的 teacherMode
        // 分支）根本沒有渲染 .rec-class／.rec-no 這兩個輸入框——不是學生，沒有
        // 班別／學號可填——所以這裡用 querySelector 找不到時要當作空字串，
        // 不能直接呼叫 .value（會整個表單儲存失敗）。
        var clsEl = row.querySelector('.rec-class');
        var noEl = row.querySelector('.rec-no');
        var cls = clsEl ? clsEl.value.trim() : '';
        var no = noEl ? noEl.value.trim() : '';
        var nm = row.querySelector('.rec-name').value.trim();
        if (!cls && !no && !nm) return;
        recipients.push({ class: cls, no: no, name: nm });
      });
    }
    if (!name && !item && recipients.length === 0) return; // fully blank block, drop silently
    // 保留原本已存在的 id／編號（seq），不因為每次儲存表單都重新讀一次 DOM 就整個
    // 重新產生——否則每次編輯記錄都會讓這個獎項的「獎項編號」跟著改變，失去編號
    // 原本要「穩定、可追蹤」的意義。全新新增的獎項區塊（含這次才匯入進來的）沒有
    // 這兩個隱藏欄位可讀（或值為空），維持原本行為：交給呼叫端
    // （commitRecordFromForm）視為新獎項，分配全新的 id／編號。
    var idInput = block.querySelector('.award-id-hidden');
    var seqInput = block.querySelector('.award-seq-hidden');
    var existingSeq = (seqInput && seqInput.value !== '') ? Number(seqInput.value) : NaN;
    var awardObj = { id: (idInput && idInput.value) ? idInput.value : uid('a'), name: name, type: type, item: item, recipients: recipients };
    if (!isNaN(existingSeq)) awardObj.seq = existingSeq;
    awards.push(awardObj);
  });
  return awards;
}

// 負責老師 is entered as a set of checkboxes (from STATE.teachers, managed in
// 設定頁「教師名單」) plus a free-text "其他" field for names not on that
// list — but it's still stored as the same newline-separated string the
// rest of the app already expects (search, 按教師 filter, CSV, stats), so
// none of that other code needed to change.
function readTeacherFromForm(formEl){
  var checked = Array.prototype.slice.call(formEl.querySelectorAll('.teacher-check:checked')).map(function(cb){ return cb.value; });
  var otherInput = formEl.querySelector('#f-teacher-other');
  var others = otherInput ? splitOtherTeacherInput(otherInput.value) : [];
  var seen = {}, result = [];
  checked.concat(others).forEach(function(n){ if (n && !seen[n]){ seen[n] = true; result.push(n); } });
  return result.join('\n');
}

// The "其他" field accepts multiple names separated by comma/頓號/newline.
function splitOtherTeacherInput(str){
  return (str || '').split(/[,，、\n]+/).map(normalizeTeacherName).filter(Boolean);
}

function commitRecordFromForm(formEl){
  var subject = formEl.querySelector('#f-subject').value;
  var event_ = formEl.querySelector('#f-event').value.trim();
  var organizer = formEl.querySelector('#f-organizer').value.trim();
  var date = formEl.querySelector('#f-date').value.trim();
  var teacher = readTeacherFromForm(formEl);
  var schoolYear = formEl.querySelector('#f-year').value;

  var errors = [];
  if (!subject) errors.push('請選擇科目');
  if (!event_) errors.push('請填寫活動 / 比賽名稱');
  if (!organizer) errors.push('請填寫主辦機構');
  if (!date) errors.push('請填寫比賽日期');
  if (!schoolYear) errors.push('請選擇學年');

  var awards = readAwardsFromForm(formEl);
  // 每次儲存都重新比對一次 studentNo（見 attachStudentNos 的說明），確保
  // 用的是當下最新的名單資料，而不是沿用舊比對結果；schoolYear 此時已從
  // 表單讀出，即使儲存失敗（下面驗證沒過）也不影響——validation 只檢查
  // 姓名是否存在，不看 studentNo。
  attachStudentNos(awards, schoolYear);
  if (awards.length === 0) errors.push('請至少新增一個獎項');
  awards.forEach(function(a, i){
    if (!a.name) errors.push('第 ' + (i+1) + ' 個獎項缺少名稱');
    // 「學校獎項」的得獎人是 readAwardsFromForm 自動補上的固定值（校名），
    // 不會是空的，也不需要老師另外驗證，所以完全跳過下面兩條檢查。
    if (a.type === 'school') return;
    var isTeacherAward = a.type === 'teacher';
    if (!a.recipients.length) errors.push('「' + (a.name || ('第' + (i+1) + '個獎項')) + '」' + (isTeacherAward ? '未填寫獲獎老師' : '未有得獎學生'));
    a.recipients.forEach(function(r){ if (!r.name) errors.push('「' + (a.name||'獎項') + '」' + (isTeacherAward ? '有欄位未填寫老師姓名' : '有學生缺少姓名')); });
  });

  var errBox = formEl.querySelector('#form-errors');
  if (errors.length){
    errBox.innerHTML = errors.map(function(e){ return '<div>' + esc(e) + '</div>'; }).join('');
    errBox.hidden = false;
    errBox.scrollIntoView({ block:'nearest' });
    return;
  }
  errBox.hidden = true;

  var record;
  if (ui.editingId){
    record = getRecord(ui.editingId);
    if (!record) { ui.editingId = null; return; }
  } else {
    record = { id: uid('r'), seq: STATE.nextSeq, source:'manual', createdAt: new Date().toISOString(), needsReview:false, reviewNote:'' };
    STATE.records.push(record);
    STATE.nextSeq += 1;
  }
  record.subject = subject;
  record.event = event_;
  record.organizer = organizer;
  record.date = date;
  record.teacher = teacher;
  record.schoolYear = schoolYear;
  // 沿用既有編號（見 readAwardsFromForm 對 .award-seq-hidden 的處理），只有真正
  // 全新的獎項（表單上新增的區塊，或這次匯入加進來的）才會缺少 seq，這裡才需要
  // 分配下一個全域獎項編號——確保既有獎項的編號不會單純因為使用者重新儲存一次
  // 這筆記錄的表單就改變。
  awards.forEach(function(a){
    if (typeof a.seq !== 'number'){ a.seq = STATE.nextAwardSeq; STATE.nextAwardSeq += 1; }
  });
  record.awards = awards;

  if (ui.adminMode){
    var a1 = formEl.querySelector('#f-admin1');
    var a2 = formEl.querySelector('#f-admin2');
    var nr = formEl.querySelector('#f-needs-review');
    if (a1) record.admin1 = a1.value.trim();
    if (a2) record.admin2 = a2.value.trim();
    if (nr) record.needsReview = nr.checked;
  }

  var wasEditing = !!ui.editingId;
  ui.editingId = null;
  setView('list');
  ui.selectedYear = schoolYear;
  ui.expandedId = record.id;
  saveAndPublish(wasEditing ? '已更新記錄' : '已新增記錄');
}

function deleteRecord(id){
  var idx = STATE.records.findIndex(function(r){ return r.id === id; });
  if (idx === -1) return;
  STATE.records.splice(idx,1);
  ui.deleteConfirmId = null;
  if (ui.expandedId === id) ui.expandedId = null;
  saveAndPublish('已刪除記錄');
}

function toggleReviewFlag(id, val){
  var rec = getRecord(id);
  if (!rec) return;
  rec.needsReview = val;
  if (!val) rec.reviewNote = '';
  saveAndPublish('已更新');
}

// Swaps a subject with its neighbour in STATE.subjects — that array's own
// order is the single canonical subject order used everywhere (list-view
// 按科目 grouping, the add/edit form's dropdown, the list filter dropdown),
// so this is the only place order needs to change.
function moveSubject(subject, dir){
  var idx = STATE.subjects.indexOf(subject);
  if (idx === -1) return;
  var next = idx + dir;
  if (next < 0 || next >= STATE.subjects.length) return;
  var tmp = STATE.subjects[idx];
  STATE.subjects[idx] = STATE.subjects[next];
  STATE.subjects[next] = tmp;
  saveAndPublish('已更新科目排序');
}

// Permanently drops every record and roster row for one school year, to
// keep the published state (and thus every render/search over it) from
// growing without bound across many years. The year itself stays in
// STATE.schoolYears (now empty) — removing that entry entirely is a
// separate, already-existing action in 學年管理.
function clearYearData(year){
  var recordCount = STATE.records.filter(function(r){ return r.schoolYear === year; }).length;
  var rosterCount = STATE.studentRosters.filter(function(r){ return r.schoolYear === year; }).length;
  STATE.records = STATE.records.filter(function(r){ return r.schoolYear !== year; });
  STATE.studentRosters = STATE.studentRosters.filter(function(r){ return r.schoolYear !== year; });
  if (ui.selectedYear === year) ui.selectedYear = STATE.meta.currentSchoolYear;
  ui.expandedId = null;
  ui.deleteConfirmId = null;
  ui.modal = null;
  saveAndPublish('已清除「' + year + '」學年的資料（' + recordCount + ' 項活動記錄、' + rosterCount + ' 筆學生名單）');
}

/* ============================================================
   Student roster CRUD
   ============================================================ */

// Insert-or-update one roster row into STATE.studentRosters for `year`.
// When studentNo is given, it is the primary key: an existing row for the
// same year + studentNo is updated in place rather than duplicated (this
// is what makes "帶入上一學年名單" / re-importing an updated file safe to
// repeat). Rows with no studentNo fall back to a class+no+name match.
function upsertRosterEntry(year, entry){
  var existing = null;
  if (entry.studentNo){
    existing = STATE.studentRosters.find(function(r){ return r.schoolYear === year && r.studentNo === entry.studentNo; });
  } else {
    existing = STATE.studentRosters.find(function(r){
      return r.schoolYear === year && !r.studentNo && r.class === entry.class && r.no === entry.no && r.name === entry.name;
    });
  }
  if (existing){
    var changed = existing.class !== entry.class || existing.no !== entry.no || existing.name !== entry.name ||
      existing.gender !== entry.gender || existing.dob !== entry.dob;
    existing.class = entry.class; existing.no = entry.no; existing.name = entry.name;
    existing.gender = entry.gender; existing.dob = entry.dob;
    return changed ? 'updated' : 'unchanged';
  }
  STATE.studentRosters.push({
    id: uid('st'), schoolYear: year, studentNo: entry.studentNo || '',
    class: entry.class || '', no: entry.no || '', name: entry.name, gender: entry.gender || '', dob: entry.dob || ''
  });
  return 'added';
}

function addRosterEntry(year, studentNo, cls, no, name, gender, dob){
  if (!name){ showToast('請輸入學生姓名'); return; }
  var result = upsertRosterEntry(year, { studentNo:studentNo, class:cls, no:no, name:name, gender:gender, dob:dob });
  if (result === 'unchanged'){ showToast('這位學生的資料沒有變化'); return; }
  saveAndPublish(result === 'updated' ? '已更新學生資料（學生編號重複，已覆蓋）' : '已新增學生');
}

function removeRosterEntry(id){
  var idx = STATE.studentRosters.findIndex(function(r){ return r.id === id; });
  if (idx === -1) return;
  STATE.studentRosters.splice(idx, 1);
  ui.rosterDeleteConfirmId = null;
  saveAndPublish('已刪除學生');
}

function copyPreviousRoster(year){
  var years = sortedSchoolYears();
  var idx = years.indexOf(year);
  if (idx <= 0){ showToast('沒有更早的學年可供帶入'); return; }
  var prevYear = years[idx - 1];
  var prevRoster = studentRosterForYear(prevYear);
  if (!prevRoster.length){ showToast('「' + prevYear + '」沒有學生名單可供帶入'); return; }
  var added = 0;
  prevRoster.forEach(function(r){
    var result = upsertRosterEntry(year, { studentNo:r.studentNo, class:r.class, no:r.no, name:r.name, gender:r.gender, dob:r.dob });
    if (result === 'added') added++;
  });
  if (!added){ showToast('「' + year + '」名單已包含全部學生'); return; }
  saveAndPublish('已從「' + prevYear + '」帶入 ' + added + ' 位學生');
}

// Distinct from detectImportColumns (used for award-recipient import,
// which only ever needs 獎項/班別/學號/姓名): a student roster row's
// primary key is 學生編號 ("student ID"), which must not be confused with
// 學號 (the per-year class roll number) even though both contain 號.
function detectRosterColumns(headerRow){
  var idx = { studentNo:-1, cls:-1, no:-1, name:-1, gender:-1, dob:-1 };
  headerRow.forEach(function(h,i){
    var v = String(h===undefined||h===null?'':h).trim();
    var lv = v.toLowerCase();
    if (idx.name===-1 && (v.indexOf('姓名')!==-1 || lv==='name' || v==='學生')) idx.name = i;
    else if (idx.studentNo===-1 && (v.indexOf('學生編號')!==-1 || lv==='id' || lv==='studentid' || lv==='student id')) idx.studentNo = i;
    else if (idx.no===-1 && (v.indexOf('學號')!==-1 || v.indexOf('班號')!==-1 || lv==='no' || lv==='no.' || lv==='number')) idx.no = i;
    else if (idx.studentNo===-1 && v.indexOf('編號')!==-1) idx.studentNo = i;
    else if (idx.cls===-1 && (v.indexOf('班別')!==-1 || v.indexOf('班')!==-1 || lv==='class')) idx.cls = i;
    else if (idx.gender===-1 && (v.indexOf('性別')!==-1 || lv==='gender' || lv==='sex')) idx.gender = i;
    else if (idx.dob===-1 && (v.indexOf('出生日期')!==-1 || v.indexOf('生日')!==-1 || lv.indexOf('birth')!==-1 || lv==='dob')) idx.dob = i;
  });
  return idx;
}

// 2026-09-07 修訂：原本讀取檔案後會立即套用變動，現在改為先做一次唯讀的
// 差異分析、彈出預覽視窗讓管理員核對「將新增/更新幾位學生」後才真正套用
// （見 confirm-roster-import），與「同步名單」的做法一致，也回應「每次
// 用戶上載 csv 或 excel 都需要先檢查是否正確才開始處理資料」的要求。
// 沿用下面「同步名單」共用的 readSpreadsheetMatrix／parseRosterRows 讀取
// 解析邏輯（欄位辨識/略過規則完全不變），不再各自保留一份重複的讀檔程式碼。
function handleRosterImportFile(file, year){
  readSpreadsheetMatrix(file, function(matrix){
    var parsed = parseRosterRows(matrix);
    if (parsed.error){ showToast(parsed.error); return; }
    if (!parsed.rows.length){ showToast('檔案沒有可匯入的學生資料（可能缺少學生編號或姓名，或無法辨識欄位）'); return; }
    var addedCount = 0, changedCount = 0, unchangedCount = 0;
    var currentByNo = {};
    STATE.studentRosters.forEach(function(r){ if (r.schoolYear === year && r.studentNo) currentByNo[r.studentNo] = r; });
    parsed.rows.forEach(function(r){
      var existing = currentByNo[r.studentNo];
      if (!existing){ addedCount++; return; }
      var changed = existing.class !== r.class || existing.no !== r.no || existing.name !== r.name ||
        existing.gender !== r.gender || existing.dob !== r.dob;
      if (changed) changedCount++; else unchangedCount++;
    });
    ui.modal = {
      type: 'roster-import-preview', year: year, rows: parsed.rows, skipped: parsed.skipped, fileName: file.name,
      addedCount: addedCount, changedCount: changedCount, unchangedCount: unchangedCount
    };
    renderModal();
  }, showToast);
}

// Shared file-reading step for "同步名單" (see below) — kept separate from
// handleRosterImportFile above (which has its own inline copy of the same
// read/parse steps) so that feature keeps working exactly as before,
// unmodified, while this new one builds a full add/update/remove plan
// instead of applying changes immediately.
function readSpreadsheetMatrix(file, onMatrix, onError){
  var isCSV = /\.csv$/i.test(file.name);
  var reader = new FileReader();
  reader.onerror = function(){ onError('讀取檔案失敗，請重試'); };
  reader.onload = function(e){
    try{
      var matrix;
      if (isCSV){
        matrix = parseCSVText(String(e.target.result));
      } else {
        if (!window.XLSX){ onError('Excel 解析元件未能載入，請稍後重試，或改用 CSV 檔案'); return; }
        var wb = XLSX.read(new Uint8Array(e.target.result), { type:'array' });
        var sheet = wb.Sheets[wb.SheetNames[0]];
        matrix = XLSX.utils.sheet_to_json(sheet, { header:1, defval:'' });
      }
      onMatrix(matrix);
    }catch(err){
      onError('無法解析此檔案：' + (err && err.message ? err.message : '格式錯誤'));
    }
  };
  if (isCSV) reader.readAsText(file, 'utf-8'); else reader.readAsArrayBuffer(file);
}

function parseRosterRows(matrix){
  if (!matrix.length) return { error: '檔案沒有內容' };
  var idx = detectRosterColumns(matrix[0]);
  if (idx.name === -1) return { error: '無法辨識姓名欄位，請確認標題包含「姓名」' };
  if (idx.studentNo === -1) return { error: '無法辨識「學生編號」欄位，請確認標題包含「學生編號」（此欄為主鍵，用作日後跨學年識別同一位學生）' };
  var rows = [], skipped = 0;
  for (var r = 1; r < matrix.length; r++){
    var row = matrix[r];
    if (!row) continue;
    var name = idx.name >= 0 ? String(row[idx.name] === undefined ? '' : row[idx.name]).trim() : '';
    var studentNo = idx.studentNo >= 0 ? String(row[idx.studentNo] === undefined ? '' : row[idx.studentNo]).trim() : '';
    if (!name || !studentNo){ if (name || studentNo) skipped++; continue; }
    var cls = idx.cls >= 0 ? String(row[idx.cls] === undefined ? '' : row[idx.cls]).trim() : '';
    var no = idx.no >= 0 ? String(row[idx.no] === undefined ? '' : row[idx.no]).trim() : '';
    var gender = idx.gender >= 0 ? String(row[idx.gender] === undefined ? '' : row[idx.gender]).trim() : '';
    var dob = idx.dob >= 0 ? String(row[idx.dob] === undefined ? '' : row[idx.dob]).trim() : '';
    rows.push({ studentNo:studentNo, class:cls, no:no, name:name, gender:gender, dob:dob });
  }
  return { rows: rows, skipped: skipped };
}

// 「同步名單」：把上傳的檔案當成該學年的完整最新名單，而不只是新增/更新
// （見上方 handleRosterImportFile 的「匯入名單」——兩者刻意保留成兩個獨立
// 按鈕，因為語意差很多：一個是純新增/更新、絕不刪除；另一個會把不在檔案
// 內的既有學生視為已離校/退學而移除，需要先預覽讓管理員確認才套用，避免
// 不小心上傳錯檔案就整批刪錯人）。這裡只計算「將會發生的變動」，實際套用
// 留給 confirm-roster-sync 這個 action，兩者之間的資料就存在 ui.modal 裡。
function handleRosterSyncFile(file, year){
  readSpreadsheetMatrix(file, function(matrix){
    var parsed = parseRosterRows(matrix);
    if (parsed.error){ showToast(parsed.error); return; }
    if (!parsed.rows.length){ showToast('檔案沒有可用的學生資料（可能缺少學生編號或姓名）'); return; }
    var fileNos = {};
    parsed.rows.forEach(function(r){ fileNos[r.studentNo] = true; });
    var currentByNo = {};
    STATE.studentRosters.forEach(function(r){ if (r.schoolYear === year && r.studentNo) currentByNo[r.studentNo] = r; });
    var toRemove = STATE.studentRosters.filter(function(r){ return r.schoolYear === year && r.studentNo && !fileNos[r.studentNo]; });
    // Read-only tally (no mutation here - upsertRosterEntry does the actual
    // writing later, on confirm) so the preview can tell "genuinely changed"
    // apart from "re-submitted with identical data", instead of lumping
    // every already-known student in as if their record were being updated.
    var addedCount = 0, changedCount = 0, unchangedCount = 0;
    parsed.rows.forEach(function(r){
      var existing = currentByNo[r.studentNo];
      if (!existing){ addedCount++; return; }
      var changed = existing.class !== r.class || existing.no !== r.no || existing.name !== r.name ||
        existing.gender !== r.gender || existing.dob !== r.dob;
      if (changed) changedCount++; else unchangedCount++;
    });
    ui.modal = {
      type: 'roster-sync-preview', year: year, rows: parsed.rows, skipped: parsed.skipped,
      addedCount: addedCount, changedCount: changedCount, unchangedCount: unchangedCount, totalRows: parsed.rows.length,
      removeIds: toRemove.map(function(r){ return r.id; }),
      removeNames: toRemove.map(function(r){ return r.name + (r.class ? '（' + r.class + '）' : ''); })
    };
    renderModal();
  }, showToast);
}

// 教師名單匯入：比學生名單簡單得多，只需要找到一個「姓名」欄，逐行讀取、
// 正規化（見 normalizeTeacherName，會順便修掉排版用的空白），與現有
// STATE.teachers 取聯集（不覆蓋、不刪除既有姓名——移除仍然只透過設定頁的
// 「移除」按鈕，見上方「教師名單」卡片的說明）。
function detectTeacherNameColumn(headerRow){
  var idx = -1;
  headerRow.forEach(function(h,i){
    if (idx !== -1) return;
    var v = String(h===undefined||h===null?'':h).trim();
    var lv = v.toLowerCase();
    if (v.indexOf('姓名')!==-1 || v.indexOf('教師')!==-1 || v.indexOf('老師')!==-1 || lv==='name' || lv==='teacher') idx = i;
  });
  return idx;
}

// 唯讀解析：算出「這份檔案會新增哪些教師」但不直接修改 STATE.teachers，
// 讓 handleTeacherImportFile 可以先彈出預覽讓管理員核對，套用留給
// confirm-teacher-import（見下方 2026-09-07 修訂說明）。
function parseTeacherRows(matrix){
  if (!matrix.length) return { error: '檔案沒有內容' };
  var nameCol = detectTeacherNameColumn(matrix[0]);
  if (nameCol === -1) return { error: '無法辨識姓名欄位，請確認標題包含「姓名」' };
  var existing = {};
  STATE.teachers.forEach(function(t){ existing[t] = true; });
  var names = [], seen = {}, skipped = 0;
  for (var r = 1; r < matrix.length; r++){
    var row = matrix[r];
    if (!row) continue;
    var raw = String(row[nameCol] === undefined ? '' : row[nameCol]).trim();
    if (!raw) continue;
    var name = normalizeTeacherName(raw);
    if (!name) continue;
    if (existing[name] || seen[name]){ skipped++; continue; }
    seen[name] = true;
    names.push(name);
  }
  if (!names.length) return { error: skipped ? '沒有新增教師（' + skipped + ' 位已經在名單內）' : '沒有讀到任何姓名，請確認檔案內容' };
  return { names: names, skipped: skipped };
}

// 2026-09-07 修訂：原本讀取檔案後會立即新增教師，現在改為先彈出預覽視窗
// 列出將新增的教師姓名，管理員確認後（confirm-teacher-import）才真正寫入
// STATE.teachers，與「批次匯入活動記錄」「同步名單」等其他匯入功能的做法
// 一致，回應「每次用戶上載 csv 或 excel 都需要先檢查是否正確才開始處理
// 資料」的要求。
function handleTeacherImportFile(file){
  readSpreadsheetMatrix(file, function(matrix){
    var parsed = parseTeacherRows(matrix);
    if (parsed.error){ showToast(parsed.error); return; }
    ui.modal = { type:'teacher-import-preview', names: parsed.names, skipped: parsed.skipped, fileName: file.name };
    renderModal();
  }, showToast);
}

function downloadTeacherImportTemplate(){
  var rows = [
    ['姓名'],
    ['陳小明'],
    ['李小華']
  ];
  downloadCSV('教師名單匯入範本.csv', rows, '已下載範本（可用 Excel 開啟）');
}

/* ============================================================
   Club / extracurricular activity (課外活動) roster CRUD + import
   ------------------------------------------------------------
   Much simpler than the student roster above: a club-roster row IS its
   own identity (schoolYear + club + class + no + name) — there's no
   separate primary key whose OTHER fields might change over time, so
   adding/importing just inserts rows that don't already exist exactly
   as-is and silently skips exact duplicates. This makes it safe to
   re-import the same exported name list repeatedly (e.g. after the
   school's own 課外活動系統 adds a new member) without ever creating
   duplicate rows.

   Unlike the student roster (which keeps "匯入名單" add-only and
   "同步名單" add+remove as two separate buttons, see handleRosterSyncFile),
   club import is a single button that does both — 2026-09-19 change,
   requested so re-uploading an activity's current member list also drops
   anyone no longer on it (e.g. a student who quit the club). The removal
   is deliberately SCOPED to only the club names that actually appear in
   the uploaded file (see handleClubImportFile): existing members of a
   club NOT mentioned anywhere in this file are left completely alone.
   This matters because a school might export just one or two activities'
   lists at a time rather than always the full 課外活動系統 export — a
   year-wide sync (delete anything absent from the file, full stop) would
   wipe out every other club's roster the moment someone uploads a
   single-activity file. Still previewed before anything is written, same
   as every other import in this app.
   ============================================================ */

function clubEntryKey(year, entry){
  return year + '␟' + (entry.club||'').trim() + '␟' + (entry.class||'').trim() + '␟' + (entry.no||'').trim() + '␟' + (entry.name||'').trim();
}

// Insert one club-roster row if an identical (club+class+no+name) row
// doesn't already exist for `year`; returns 'added' or 'duplicate'.
function upsertClubEntry(year, entry){
  var key = clubEntryKey(year, entry);
  var exists = STATE.clubRosters.some(function(r){ return clubEntryKey(r.schoolYear, r) === key; });
  if (exists) return 'duplicate';
  STATE.clubRosters.push({
    id: uid('cl'), schoolYear: year, club: (entry.club||'').trim(),
    class: (entry.class||'').trim(), no: (entry.no||'').trim(), name: (entry.name||'').trim()
  });
  return 'added';
}

function addClubEntry(year, club, cls, no, name){
  if (!club){ showToast('請輸入課外活動名稱'); return; }
  if (!name){ showToast('請輸入學生姓名'); return; }
  var result = upsertClubEntry(year, { club:club, class:cls, no:no, name:name });
  if (result === 'duplicate'){ showToast('這位學生已經在這個課外活動名單內'); return; }
  saveAndPublish('已新增課外活動成員');
}

function removeClubEntry(id){
  var idx = STATE.clubRosters.findIndex(function(r){ return r.id === id; });
  if (idx === -1) return;
  STATE.clubRosters.splice(idx, 1);
  ui.clubRosterDeleteConfirmId = null;
  saveAndPublish('已刪除課外活動成員');
}

// Recognizes the school's own 課外活動/學會 membership export format
// (學會編號/學會名稱/學期/班別/學號/內聯網帳號/學生姓名/職位/表現/意見/
// 活躍非活躍 — the sample file this feature was built against) but only
// pulls the four columns this app actually needs; every other column is
// simply ignored, so the file can be uploaded exactly as exported.
function detectClubColumns(headerRow){
  var idx = { club:-1, cls:-1, no:-1, name:-1 };
  headerRow.forEach(function(h,i){
    var v = String(h===undefined||h===null?'':h).trim();
    var lv = v.toLowerCase();
    // Precise club-name phrasings first — checked ahead of, and independently
    // from, the generic "學會"/"活動" fallback below. The sample export this
    // was built against has BOTH a "學會編號" (club ID) and "學會名稱" (club
    // name) column, in that order; a loose "contains 學會" fallback checked
    // in plain column order would match "學會編號" first and never reach
    // "學會名稱" at all (its own idx.club===-1 guard would already be false).
    if (idx.name===-1 && (v.indexOf('學生姓名')!==-1 || v.indexOf('姓名')!==-1 || lv==='name')) idx.name = i;
    else if (idx.club===-1 && (v.indexOf('學會名稱')!==-1 || v.indexOf('活動名稱')!==-1 || v.indexOf('社團名稱')!==-1 || v.indexOf('課外活動')!==-1)) idx.club = i;
    else if (idx.no===-1 && (v.indexOf('學號')!==-1 || v.indexOf('班號')!==-1 || lv==='no' || lv==='no.')) idx.no = i;
    else if (idx.cls===-1 && (v.indexOf('班別')!==-1 || v.indexOf('班')!==-1 || lv==='class')) idx.cls = i;
  });
  // Looser fallback for a bare "學會"/"社團"/"活動" header, only once the
  // precise phrasings above found nothing — and only for a column that
  // isn't itself an ID/account column (編號/帳號), which is what a bare
  // "學會" substring check would otherwise wrongly match first.
  if (idx.club === -1){
    headerRow.forEach(function(h,i){
      if (idx.club !== -1) return;
      var v = String(h===undefined||h===null?'':h).trim();
      if (v.indexOf('編號')!==-1 || v.indexOf('帳號')!==-1) return;
      if (v.indexOf('學會')!==-1 || v.indexOf('社團')!==-1 || v.indexOf('活動')!==-1) idx.club = i;
    });
  }
  return idx;
}

function parseClubRosterRows(matrix){
  if (!matrix.length) return { error: '檔案沒有內容' };
  var idx = detectClubColumns(matrix[0]);
  if (idx.club === -1) return { error: '無法辨識課外活動名稱欄位，請確認標題包含「學會名稱」或「活動名稱」' };
  if (idx.name === -1) return { error: '無法辨識姓名欄位，請確認標題包含「姓名」' };
  var rows = [], skipped = 0;
  for (var r = 1; r < matrix.length; r++){
    var row = matrix[r];
    if (!row) continue;
    var club = String(row[idx.club] === undefined ? '' : row[idx.club]).trim();
    var name = idx.name >= 0 ? String(row[idx.name] === undefined ? '' : row[idx.name]).trim() : '';
    if (!club || !name){ if (club || name) skipped++; continue; }
    var cls = idx.cls >= 0 ? String(row[idx.cls] === undefined ? '' : row[idx.cls]).trim() : '';
    var no = idx.no >= 0 ? String(row[idx.no] === undefined ? '' : row[idx.no]).trim() : '';
    rows.push({ club:club, class:cls, no:no, name:name });
  }
  return { rows: rows, skipped: skipped };
}

function handleClubImportFile(file, year){
  readSpreadsheetMatrix(file, function(matrix){
    var parsed = parseClubRosterRows(matrix);
    if (parsed.error){ showToast(parsed.error); return; }
    if (!parsed.rows.length){ showToast('檔案沒有可匯入的課外活動成員資料（可能缺少學會名稱或姓名，或無法辨識欄位）'); return; }
    // De-dupe within the file itself (one member can legitimately appear
    // once per club, so this only catches exact repeated rows) before
    // tallying against what's already on file, so the preview's counts
    // and the actual import (confirm-club-import, which just loops
    // uniqueRows through upsertClubEntry) always agree.
    var seen = {}, dupInFile = 0, uniqueRows = [];
    parsed.rows.forEach(function(r){
      var key = clubEntryKey(year, r);
      if (seen[key]){ dupInFile++; return; }
      seen[key] = true;
      uniqueRows.push(r);
    });
    var existingCount = 0;
    uniqueRows.forEach(function(r){
      var key = clubEntryKey(year, r);
      if (STATE.clubRosters.some(function(er){ return clubEntryKey(er.schoolYear, er) === key; })) existingCount++;
    });
    var clubSet = {};
    uniqueRows.forEach(function(r){ clubSet[r.club] = true; });

    // Members currently on file for THIS year, in one of the clubs this
    // upload actually covers, whose exact row no longer appears in the
    // new file — i.e. dropped from the club. Scoped to clubSet so clubs
    // this file says nothing about are never touched (see the comment
    // block above this section for why that scoping matters).
    var newKeySet = {};
    uniqueRows.forEach(function(r){ newKeySet[clubEntryKey(year, r)] = true; });
    var toRemove = STATE.clubRosters.filter(function(r){
      return r.schoolYear === year && clubSet[r.club] && !newKeySet[clubEntryKey(r.schoolYear, r)];
    });

    ui.modal = {
      type: 'club-import-preview', year: year, rows: uniqueRows, skipped: parsed.skipped + dupInFile,
      fileName: file.name, clubCount: Object.keys(clubSet).length,
      newCount: uniqueRows.length - existingCount, existingCount: existingCount,
      removeIds: toRemove.map(function(r){ return r.id; }),
      removeNames: toRemove.map(function(r){ return r.name + '（' + r.club + (r.class ? '・' + r.class : '') + '）'; })
    };
    renderModal();
  }, showToast);
}

function downloadClubImportTemplate(){
  var rows = [
    ['學會名稱', '班別', '學號', '學生姓名'],
    ['乒乓球隊', '5A', '1', '陳小明'],
    ['乒乓球隊', '5A', '2', '李小華']
  ];
  downloadCSV('課外活動名單匯入範本.csv', rows, '已下載範本（可用 Excel 開啟）');
}

/* ============================================================
   Admin login
   ============================================================ */

function requireAdmin(nextView){
  if (ui.adminMode){ setView(nextView); render(); return; }
  ui.modal = { type:'login', nextView: nextView };
  renderModal();
}

// 2026-09-21 Firebase 版本：密碼是否正確，改由 Firestore 規則核對（見
// firebase-init.js 的 adminLogin()）——這裡送出去、等結果回來才知道對不對，
// 不再是本地字串比對，所以整個函式變成非同步。密碼一旦核對成功，Firestore 那邊
// 會記住「這個帳號現在是管理員」，之後的管理員操作不需要再重新輸入密碼（見
// firestore.rules 的 isAdmin() 說明）。
function attemptLogin(password){
  var box = document.getElementById('login-error');
  if (box) box.hidden = true;
  if (!window.fbApi){
    if (box) box.hidden = false;
    return;
  }
  window.fbApi.adminLogin(password).then(function(){
    ui.adminMode = true;
    safeSessionSet('awardsAdminMode','1');
    var next = (ui.modal && ui.modal.nextView) || ui.view;
    ui.modal = null;
    setView(GATED_VIEWS[next] ? next : ui.view);
    render();
  }).catch(function(){
    var errBox = document.getElementById('login-error');
    if (errBox) errBox.hidden = false;
  });
}

function adminLogout(){
  ui.adminMode = false;
  safeSessionRemove('awardsAdminMode');
  if (GATED_VIEWS[ui.view]) setView('list');
  render();
  if (window.fbApi) window.fbApi.adminLogout();
}

/* ============================================================
   Header / shell
   ============================================================ */

var NAV_ITEMS = [
  { id:'add', label:'新增記錄' },
  { id:'list', label:'獲獎記錄' },
  { id:'students', label:'學生名單', gated:true },
  { id:'stats', label:'統計排行', gated:true },
  { id:'settings', label:'設定與匯出', gated:true },
];

function renderShell(){
  var recordsThisYear = recordsForYear(ui.selectedYear);
  var reviewCount = recordsThisYear.filter(function(r){ return r.needsReview; }).length;

  var navHtml = NAV_ITEMS.filter(function(item){ return !item.gated || ui.adminMode; }).map(function(item){
    var active = ui.view === item.id;
    var pill = '';
    if (item.id === 'settings' && reviewCount > 0) pill = '<span class="count-pill warn">' + reviewCount + '</span>';
    if (item.id === 'list') pill = '<span class="count-pill">' + recordsThisYear.length + '</span>';
    return '<button class="nav-btn' + (active?' active':'') + '" data-action="nav" data-view="' + item.id + '">' +
      esc(item.label) + pill + '</button>';
  }).join('');

  var yearOptions = STATE.schoolYears.map(function(y){
    return '<option value="' + escAttr(y) + '"' + (y===ui.selectedYear?' selected':'') + '>' + esc(y) + '</option>';
  }).join('');

  var adminHtml = ui.adminMode
    ? '<button class="admin-pill" type="button" data-action="admin-logout"><span class="dot"></span>管理員模式（登出）</button>'
    : '<button class="admin-pill" type="button" data-action="open-login">管理員登入</button>';

  // 2026-09-21 Firebase 版本：目前用哪個 @lwcps.edu.hk 帳號登入、登出（Google 帳號，
  // 不是上面的管理員密碼）——currentUserEmail 由檔案最後 Firebase bootstrap 段落
  // 的 fbApi.onAuthChange() 設定。
  var userHtml = currentUserEmail
    ? '<button class="admin-pill" type="button" data-action="google-logout" title="登出 Google 帳號">' + esc(currentUserEmail) + ' · 登出</button>'
    : '';

  return (
    '<div class="header">' +
      '<div class="header-inner">' +
        '<div class="brand">' +
          '<span class="brand-mark">學生獲獎紀錄</span>' +
          '<span class="brand-name">' + esc(STATE.meta.schoolName || '') + '</span>' +
        '</div>' +
        '<nav class="nav-group">' + navHtml + '</nav>' +
        '<div class="header-spacer"></div>' +
        '<select class="year-select" id="year-select">' + yearOptions + '</select>' +
        userHtml +
        adminHtml +
      '</div>' +
    '</div>' +
    '<div class="page-header"><div class="page-header-inner">' +
      '<div><h1>' + esc(viewTitle()) + '</h1><div class="sub">' + esc(viewSub()) + '</div></div>' +
    '</div></div>' +
    '<div class="content" id="view-content">' + renderView() + '</div>' +
    '<div class="toast-wrap" id="toast-wrap"></div>' +
    '<div id="modal-root"></div>'
  );
}

function viewTitle(){
  switch(ui.view){
    case 'add': return ui.editingId ? '編輯記錄' : '新增獲獎記錄';
    case 'list': return '獲獎記錄';
    case 'students': return '學生名單';
    case 'stats': return '統計排行';
    case 'settings': return '設定與匯出';
  }
  return '';
}
function viewSub(){
  switch(ui.view){
    case 'add': return ui.editingId ? '修改已存在的活動與獎項資料' : '填寫比賽 / 活動，並按獎項列出所有得獎學生';
    case 'list': return '搜尋、查看及編輯已記錄的獲獎項目，可按科目／學生／教師分組檢視（' + esc(ui.selectedYear) + '）';
    case 'students': return '管理每學年學生名單、查詢學生跨學年的獲獎記錄（管理員專用）';
    case 'stats': return '各科目、班別及學生的獲獎統計（管理員專用）';
    case 'settings': return '管理科目、學年、處理待確認記錄、匯出資料（管理員專用）';
  }
  return '';
}

function renderView(){
  if (GATED_VIEWS[ui.view] && !ui.adminMode){ setView('list'); }
  switch(ui.view){
    case 'add': return renderAddView();
    case 'list': return renderListView();
    case 'students': return renderStudentsView();
    case 'stats': return renderStatsView();
    case 'settings': return renderSettingsView();
  }
  return '';
}

function render(){
  root.innerHTML = renderShell();
}

function renderModal(){
  var container = document.getElementById('modal-root');
  if (!container) return;
  if (!ui.modal){ container.innerHTML = ''; return; }

  if (ui.modal.type === 'login'){
    container.innerHTML =
      '<div class="modal-backdrop" data-action="modal-backdrop">' +
        '<div class="modal">' +
          '<h3 style="margin-bottom:14px">管理員登入' + hintIcon('輸入管理員密碼以查看統計排行及設定頁面') + '</h3>' +
          '<form id="login-form" class="stack">' +
            '<input type="password" id="login-password" placeholder="密碼" autocomplete="off">' +
            '<div id="login-error" class="banner banner-warn" hidden>密碼錯誤，請重新輸入</div>' +
            '<div class="row" style="justify-content:flex-end">' +
              '<button type="button" class="btn" data-action="close-modal">取消</button>' +
              '<button type="submit" class="btn btn-primary">登入</button>' +
            '</div>' +
          '</form>' +
        '</div>' +
      '</div>';
    var pw = document.getElementById('login-password');
    if (pw) pw.focus();
    return;
  }

  if (ui.modal.type === 'import'){
    var groups = ui.modal.groups;
    var totalRecipients = groups.reduce(function(n,g){ return n + g.recipients.length; }, 0);
    var rowsHtml = groups.map(function(g){
      var names = g.recipients.map(function(r){
        // 與上方「recipient-chip」（獎項列表展開面板）同步採用「班別(學號) 姓名」格式，
        // 見 2026-09-19 第十三次更新。
        return (g.type === 'school' || g.type === 'teacher') ? esc(r.name) : (esc(r.class||'—') + (r.no ? '(' + esc(r.no) + ')' : '') + ' ' + esc(r.name));
      }).join('、');
      var typeLabel = g.type === 'team' ? '團體' : (g.type === 'school' ? '學校' : (g.type === 'teacher' ? '教師' : '個人'));
      return '<tr><td class="cell-muted">' + esc(g.item || '—') + '</td><td>' + esc(g.name || '（未命名獎項）') + '</td><td>' + typeLabel + '</td><td>' + g.recipients.length + ' 人</td><td class="cell-muted">' + names + '</td></tr>';
    }).join('');
    container.innerHTML =
      '<div class="modal-backdrop" data-action="modal-backdrop">' +
        '<div class="modal modal-wide">' +
          '<h3>匯入獎項預覽</h3>' +
          '<div class="hint" style="margin:8px 0 14px">檔案「' + esc(ui.modal.fileName) + '」，共 ' + groups.length + ' 個獎項、' + totalRecipients + ' 位得獎學生。確認後會加到目前的獎項清單（不會覆蓋已填寫的內容）。若檔案沒有「類型」欄，全部預設為「個人」；若沒有「項目」欄，全部留空——匯入後都可在表單中個別更正。</div>' +
          (groups.length ? '<div class="import-preview-table"><table class="data"><thead><tr><th>項目</th><th>獎項</th><th>類型</th><th>人數</th><th>學生</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'
            : '<div class="banner banner-warn">無法從檔案中辨識任何資料，請確認欄位包含「獎項」「班別」「姓名」。</div>') +
          '<div class="row" style="justify-content:flex-end;margin-top:14px">' +
            '<button class="btn" type="button" data-action="close-modal">取消</button>' +
            '<button class="btn btn-primary" type="button" data-action="confirm-import"' + (groups.length?'':' disabled') + '>確認匯入</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    return;
  }

  if (ui.modal.type === 'clear-year'){
    var cyYear = ui.modal.year;
    container.innerHTML =
      '<div class="modal-backdrop" data-action="modal-backdrop">' +
        '<div class="modal">' +
          '<h3>清除學年資料</h3>' +
          '<div class="banner banner-warn" style="margin:10px 0">此操作會永久刪除「' + esc(cyYear) + '」學年的全部獲獎記錄' +
            (ui.modal.rosterCount ? '及學生名單' : '') + '，且無法復原。</div>' +
          '<div class="hint" style="margin-bottom:10px">將刪除 ' + ui.modal.recordCount + ' 項活動記錄' +
            (ui.modal.rosterCount ? '、' + ui.modal.rosterCount + ' 筆學生名單資料' : '') + '。</div>' +
          '<div class="field">' +
            '<label>請輸入學年名稱「' + esc(cyYear) + '」以確認</label>' +
            '<input type="text" id="clear-year-confirm-input" placeholder="' + escAttr(cyYear) + '" autocomplete="off">' +
          '</div>' +
          '<div class="row" style="justify-content:flex-end;margin-top:14px">' +
            '<button class="btn" type="button" data-action="close-modal">取消</button>' +
            '<button class="btn btn-danger" type="button" data-action="confirm-clear-year">確認清除</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    var cyInputEl = document.getElementById('clear-year-confirm-input');
    if (cyInputEl) cyInputEl.focus();
    return;
  }

  if (ui.modal.type === 'roster-sync-preview'){
    var rs = ui.modal;
    var removePreview = rs.removeNames.slice(0, 12).map(esc).join('、') + (rs.removeNames.length > 12 ? ' 等' : '');
    container.innerHTML =
      '<div class="modal-backdrop" data-action="modal-backdrop">' +
        '<div class="modal modal-wide">' +
          '<h3>同步「' + esc(rs.year) + '」學生名單</h3>' +
          '<div class="hint" style="margin-bottom:10px">系統會把這份檔案當成「' + esc(rs.year) + '」的完整最新名單：檔案內的學生會被新增或更新資料；<b>目前名單中但不在這份檔案內的學生，會被視為已離校／退學而移除</b>（不會影響這些學生過去已記錄的獲獎資料，只是從名單中移除）。</div>' +
          '<div class="row wrap" style="gap:20px;margin-bottom:10px">' +
            '<div>新增 <b>' + rs.addedCount + '</b> 位</div>' +
            '<div>資料有變 <b>' + rs.changedCount + '</b> 位</div>' +
            '<div class="cell-muted">不變 ' + rs.unchangedCount + ' 位</div>' +
            '<div style="color:var(--color-bad)">移除 <b>' + rs.removeIds.length + '</b> 位</div>' +
          '</div>' +
          (rs.removeIds.length ? '<div class="banner banner-warn" style="margin-bottom:10px">將移除：' + removePreview + '</div>' : '') +
          (rs.skipped ? '<div class="hint" style="margin-bottom:10px">另有 ' + rs.skipped + ' 列缺少學生編號或姓名，已略過。</div>' : '') +
          '<div class="row" style="justify-content:flex-end;margin-top:4px">' +
            '<button class="btn" type="button" data-action="close-modal">取消</button>' +
            '<button class="btn btn-danger" type="button" data-action="confirm-roster-sync">確認同步</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    return;
  }

  if (ui.modal.type === 'roster-import-preview'){
    var ri = ui.modal;
    container.innerHTML =
      '<div class="modal-backdrop" data-action="modal-backdrop">' +
        '<div class="modal modal-wide">' +
          '<h3>匯入「' + esc(ri.year) + '」學生名單預覽</h3>' +
          '<div class="hint" style="margin-bottom:10px">檔案「' + esc(ri.fileName) + '」，共 ' + ri.rows.length + ' 筆可匯入的學生資料。只會新增或更新檔案內的學生，<b>不會</b>移除其他學生（如需處理退學/插班，請改用「同步名單」）。</div>' +
          '<div class="row wrap" style="gap:20px;margin-bottom:10px">' +
            '<div>新增 <b>' + ri.addedCount + '</b> 位</div>' +
            '<div>資料有變 <b>' + ri.changedCount + '</b> 位</div>' +
            '<div class="cell-muted">不變 ' + ri.unchangedCount + ' 位</div>' +
          '</div>' +
          (ri.skipped ? '<div class="hint" style="margin-bottom:10px">另有 ' + ri.skipped + ' 列缺少學生編號或姓名，已略過。</div>' : '') +
          '<div class="row" style="justify-content:flex-end;margin-top:4px">' +
            '<button class="btn" type="button" data-action="close-modal">取消</button>' +
            '<button class="btn btn-primary" type="button" data-action="confirm-roster-import">確認匯入</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    return;
  }

  if (ui.modal.type === 'teacher-import-preview'){
    var ti = ui.modal;
    var tiPreview = ti.names.slice(0, 30).map(esc).join('、') + (ti.names.length > 30 ? ' 等' : '');
    container.innerHTML =
      '<div class="modal-backdrop" data-action="modal-backdrop">' +
        '<div class="modal modal-wide">' +
          '<h3>匯入教師名單預覽</h3>' +
          '<div class="hint" style="margin-bottom:10px">檔案「' + esc(ti.fileName) + '」，將新增 <b>' + ti.names.length + '</b> 位教師' +
            (ti.skipped ? '（另有 ' + ti.skipped + ' 位已經在名單內或檔案中重複，已略過）' : '') + '：</div>' +
          '<div class="banner banner-info" style="margin-bottom:10px">' + tiPreview + '</div>' +
          '<div class="row" style="justify-content:flex-end;margin-top:4px">' +
            '<button class="btn" type="button" data-action="close-modal">取消</button>' +
            '<button class="btn btn-primary" type="button" data-action="confirm-teacher-import">確認新增</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    return;
  }

  if (ui.modal.type === 'club-import-preview'){
    var ci = ui.modal;
    var ciRemovePreview = ci.removeNames.slice(0, 12).map(esc).join('、') + (ci.removeNames.length > 12 ? ' 等' : '');
    container.innerHTML =
      '<div class="modal-backdrop" data-action="modal-backdrop">' +
        '<div class="modal modal-wide">' +
          '<h3>匯入「' + esc(ci.year) + '」課外活動名單預覽</h3>' +
          '<div class="hint" style="margin-bottom:10px">檔案「' + esc(ci.fileName) + '」，共 ' + ci.rows.length + ' 筆資料、涉及 ' + ci.clubCount + ' 個課外活動。系統會把這份檔案當成<b>這些活動</b>的最新名單：新增名單中未有的成員；<b>這些活動目前名單中，但不在這份檔案內的成員會被視為已退出而移除</b>。沒有出現在這份檔案裡的其他課外活動完全不受影響。</div>' +
          '<div class="row wrap" style="gap:20px;margin-bottom:10px">' +
            '<div>將新增 <b>' + ci.newCount + '</b> 筆</div>' +
            '<div class="cell-muted">不變 ' + ci.existingCount + ' 筆</div>' +
            '<div style="color:var(--color-bad)">移除 <b>' + ci.removeIds.length + '</b> 筆</div>' +
          '</div>' +
          (ci.removeIds.length ? '<div class="banner banner-warn" style="margin-bottom:10px">將移除：' + ciRemovePreview + '</div>' : '') +
          (ci.skipped ? '<div class="hint" style="margin-bottom:10px">另有 ' + ci.skipped + ' 列缺少學會名稱或姓名，或與檔案內其他列重複，已略過。</div>' : '') +
          '<div class="row" style="justify-content:flex-end;margin-top:4px">' +
            '<button class="btn" type="button" data-action="close-modal">取消</button>' +
            '<button class="btn ' + (ci.removeIds.length ? 'btn-danger' : 'btn-primary') + '" type="button" data-action="confirm-club-import"' + (ci.newCount || ci.removeIds.length ? '' : ' disabled') + '>確認匯入</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    return;
  }

  if (ui.modal.type === 'remove-teacher-confirm'){
    var rtName = ui.modal.name;
    container.innerHTML =
      '<div class="modal-backdrop" data-action="modal-backdrop">' +
        '<div class="modal">' +
          '<h3>移除教師「' + esc(rtName) + '」</h3>' +
          '<div class="hint" style="margin-bottom:10px">目前有 ' + ui.modal.count + ' 筆記錄的「負責老師」含有這個名字。移除只是把「' +
            esc(rtName) + '」從名單中拿掉，<b>不會</b>更改任何既有記錄——這些記錄的負責老師欄位仍會照樣顯示「' + esc(rtName) +
            '」，之後編輯時會落在「其他老師」欄位而不是勾選方塊。確定移除嗎？</div>' +
          '<div class="row" style="justify-content:flex-end;margin-top:14px">' +
            '<button class="btn" type="button" data-action="close-modal">取消</button>' +
            '<button class="btn btn-danger" type="button" data-action="confirm-remove-teacher" data-teacher="' + escAttr(rtName) + '">確定移除</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    return;
  }

  if (ui.modal.type === 'remove-subject-confirm'){
    var rsSubj = ui.modal.subject;
    container.innerHTML =
      '<div class="modal-backdrop" data-action="modal-backdrop">' +
        '<div class="modal">' +
          '<h3>移除科目「' + esc(rsSubj) + '」</h3>' +
          '<div class="hint" style="margin-bottom:10px">目前有 ' + ui.modal.count + ' 筆記錄的科目是「' +
            esc(rsSubj) + '」。移除只是把「' + esc(rsSubj) + '」從新增/編輯記錄的科目選單中拿掉，<b>不會</b>' +
            '更改任何既有記錄——這些記錄仍會照樣顯示、可以編輯、被列入統計與 CSV 匯出，只是之後新增/編輯' +
            '記錄時這個科目不會再出現在選單裡。如果之後想把這些記錄改到別的科目，可以用「重新命名」把這個' +
            '科目合併到另一個科目，或逐筆編輯記錄更改科目。確定移除嗎？</div>' +
          '<div class="row" style="justify-content:flex-end;margin-top:14px">' +
            '<button class="btn" type="button" data-action="close-modal">取消</button>' +
            '<button class="btn btn-danger" type="button" data-action="confirm-remove-subject" data-subject="' + escAttr(rsSubj) + '">確定移除</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    return;
  }

  if (ui.modal.type === 'rename-subject'){
    var rnSubj = ui.modal.subject;
    var rnUseCount = STATE.records.filter(function(r){ return r.subject === rnSubj; }).length;
    container.innerHTML =
      '<div class="modal-backdrop" data-action="modal-backdrop">' +
        '<div class="modal">' +
          '<h3>重新命名科目「' + esc(rnSubj) + '」</h3>' +
          '<div class="hint" style="margin-bottom:10px">' +
            (rnUseCount ? '會同時更新目前 ' + rnUseCount + ' 筆使用這個科目的記錄。' : '') +
            '如果輸入的名稱剛好是另一個已存在的科目，會直接把這個科目合併過去（不會留下重複的科目）。</div>' +
          '<div class="field">' +
            '<label>新科目名稱</label>' +
            '<input type="text" id="rename-subject-input" value="' + escAttr(rnSubj) + '" autocomplete="off">' +
          '</div>' +
          '<div class="row" style="justify-content:flex-end;margin-top:14px">' +
            '<button class="btn" type="button" data-action="close-modal">取消</button>' +
            '<button class="btn btn-primary" type="button" data-action="confirm-rename-subject" data-subject="' + escAttr(rnSubj) + '">確認重新命名</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    var rnInputEl = document.getElementById('rename-subject-input');
    if (rnInputEl){ rnInputEl.focus(); rnInputEl.select(); }
    return;
  }

  if (ui.modal.type === 'bulk-import-preview'){
    var bi = ui.modal;
    var totalAwards = bi.records.reduce(function(n,r){ return n + r.awards.length; }, 0);
    var totalRecipients = bi.records.reduce(function(n,r){ return n + r.awards.reduce(function(m,a){ return m + a.recipients.length; }, 0); }, 0);
    var biRowsHtml = bi.records.map(function(r, i){
      var awardNames = r.awards.map(function(a){ return (a.item ? a.item + '/' : '') + (a.name || '（未命名獎項）'); }).join('、');
      var recipCount = r.awards.reduce(function(m,a){ return m + a.recipients.length; }, 0);
      return '<tr>' +
        '<td class="cell-muted">' + (i+1) + '</td>' +
        '<td>' + (r.subject ? esc(r.subject) : '<span class="badge badge-warn">缺科目</span>') + '</td>' +
        '<td>' + (r.event ? esc(r.event) : '<span class="badge badge-warn">缺活動名稱</span>') + '</td>' +
        '<td class="cell-muted">' + esc(r.date || '—') + '</td>' +
        '<td>' + r.awards.length + ' 個獎項 · ' + recipCount + ' 人</td>' +
        '<td class="cell-muted">' + esc(awardNames) + '</td>' +
      '</tr>';
    }).join('');
    container.innerHTML =
      '<div class="modal-backdrop" data-action="modal-backdrop">' +
        '<div class="modal modal-wide">' +
          '<h3>批次匯入活動記錄預覽</h3>' +
          '<div class="hint" style="margin:8px 0 14px">檔案「' + esc(bi.fileName) + '」，偵測到 <b>' + bi.records.length + '</b> 筆活動記錄、共 ' + totalAwards + ' 個獎項、' + totalRecipients + ' 位得獎人次。確認後會全部新增為獨立的活動記錄，不會覆蓋任何既有記錄。' +
            (bi.missingSubjectCount || bi.missingEventCount ? '有 ' + Math.max(bi.missingSubjectCount, bi.missingEventCount) + ' 筆記錄缺少科目或活動名稱，會先標記為「待確認」（缺科目的暫用「' + esc(STATE.subjects[0]||'') + '」），確認匯入後請在「設定與匯出」的待確認清單逐一核對更正。' : '') +
          '</div>' +
          (bi.records.length ? '<div class="import-preview-table"><table class="data"><thead><tr><th>#</th><th>科目</th><th>活動/比賽名稱</th><th>日期</th><th>獎項</th><th>明細</th></tr></thead><tbody>' + biRowsHtml + '</tbody></table></div>'
            : '<div class="banner banner-warn">無法從檔案中辨識任何資料，請確認欄位包含「活動」「獎項」「班別」「姓名」等欄位。</div>') +
          '<div class="row" style="justify-content:flex-end;margin-top:14px">' +
            '<button class="btn" type="button" data-action="close-modal">取消</button>' +
            '<button class="btn btn-primary" type="button" data-action="confirm-bulk-import"' + (bi.records.length?'':' disabled') + '>確認匯入 ' + bi.records.length + ' 筆記錄</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    return;
  }
}

/* ============================================================
   Add / Edit view
   ============================================================ */

function subjectOptions(selected){
  var opts = STATE.subjects.slice();
  // 防呆：如果這筆記錄目前的科目已經不在 STATE.subjects 名單內（例如管理員在設定頁移除了
  // 這個科目，但仍有記錄使用中——見「科目分類：移除限制放寬」專節），仍然要把這個值加進下拉
  // 選單並選中它，否則儲存表單時會在使用者沒有察覺的情況下，把這筆記錄的科目靜默改成清單
  // 第一個科目（`<select>` 找不到與 selected 相符的 option 時，瀏覽器預設選中第一項）。
  if (selected && opts.indexOf(selected) === -1) opts.push(selected);
  return opts.map(function(s){
    return '<option value="' + escAttr(s) + '"' + (s===selected?' selected':'') + '>' + esc(s) + '</option>';
  }).join('');
}
function yearOptionsFor(selected){
  return STATE.schoolYears.map(function(y){
    return '<option value="' + escAttr(y) + '"' + (y===selected?' selected':'') + '>' + esc(y) + '</option>';
  }).join('');
}

// teacherMode（2026-09-09 新增「學校/教師獎項」時稱為 schoolMode，2026-09-19
// 第十一次更新把「學校/教師獎項」拆成獨立的「學校獎項」與「教師獎項」兩個類型後
// 改名並收窄成只代表「教師獎項」——「學校獎項」的得獎人固定是校方本身、完全不需要
// 輸入，因此已不再經過這個函式，見 awardBlockHTML 的 isSchool 分支，直接顯示一句
// 自動說明文字，不渲染任何 recipient-row）：當這一列屬於「教師獎項」
// （award.type === 'teacher'）時，得獎人是老師本人、不是學生，班別／學號兩個欄位
// 完全沒有意義，所以直接不渲染這兩個輸入框，只留一個名稱欄（用來填老師姓名）＋
// 移除按鈕——不是用 CSS 把它們藏起來，是整個 DOM 結構就不同（原因見
// readAwardsFromForm 的對應說明：省得表單儲存時還要判斷「這個欄位是隱藏所以要忽略」，
// 直接用 querySelector 找不到元素自然就代表「這裡沒有這個欄位」）。允許同一個獎項底下
// 新增多筆（例如多位老師共同得獎），沿用既有的多筆得獎人機制，不需要另外設計。
function recipientRowHTML(rp, teacherMode){
  rp = rp || { class:'', no:'', name:'' };
  if (teacherMode){
    return (
      '<div class="recipient-row recipient-row-teacher" style="display:flex;gap:8px;align-items:center">' +
        '<input type="text" class="rec-name" placeholder="獲獎老師姓名" value="' + escAttr(rp.name) + '" aria-label="獲獎老師姓名" style="flex:1 1 auto">' +
        '<button type="button" class="rm-btn" data-action="remove-recipient-row" title="移除">✕</button>' +
      '</div>'
    );
  }
  return (
    '<div class="recipient-row">' +
      '<input type="text" class="rec-class" placeholder="班別" value="' + escAttr(rp.class) + '" aria-label="班別">' +
      '<input type="text" class="rec-no" placeholder="學號" value="' + escAttr(rp.no) + '" aria-label="學號">' +
      '<input type="text" class="rec-name" placeholder="學生姓名" value="' + escAttr(rp.name) + '" aria-label="學生姓名">' +
      '<button type="button" class="rm-btn" data-action="remove-recipient-row" title="移除">✕</button>' +
    '</div>'
  );
}

// "從學生名單選取" 得獎人快速加入（2026-09-11 新增，回應「新增獲獎記錄中想讓學生可以選擇班別後
// 選擇多名學生後再加入」的要求）：每個「個人」／「團體」（非「學校獎項」／「教師獎項」）的獎項區塊，在「+ 新增得獎學生」旁多一個
// 下拉面板——選班別，再勾選該班別內多位學生，按「加入所選」一次把班別/學號/姓名都自動填好、附加成
// 多列得獎人，不用每位學生都手動打三個欄位。刻意重用「負責老師」多選面板的既有 CSS
// （.ms-dropdown/.ms-panel/.ms-options/.ms-option）與既有「點擊面板外自動關閉」的事件委派邏輯
// （見下方事件委派區塊開頭那段通用的 `.ms-panel:not([hidden])` 判斷，本來就不限定只認「負責老師」
// 面板，直接適用），不用另外設計一套樣式或開關機制。資料來源是 STATE.studentRosters（見上方
// rosterClassesForYear/rosterStudentsForClass），因此**需要管理員先在「學生名單」頁面替該學年
// 建立好名單，此面板才有東西可選**；尚未建立名單的學年，面板內會顯示對應提示文字，不會擋住「+ 新增
// 得獎學生」這個原本手動輸入的路徑（兩者並存，不是取代關係）。
function rosterPickerHTML(){
  return (
    '<div class="ms-dropdown roster-picker">' +
      '<button type="button" class="btn btn-sm" data-action="toggle-roster-picker" title="先選班別，再勾選多位學生一次加入">從學生名單選取</button>' +
      '<div class="ms-panel roster-picker-panel" hidden style="width:260px;max-width:80vw">' +
        '<select class="roster-picker-class" aria-label="選擇班別"><option value="">請選擇班別</option></select>' +
        '<div class="roster-picker-list ms-options"><div class="ms-option-empty">請先選擇班別</div></div>' +
        '<div class="row" style="gap:6px;justify-content:space-between;align-items:center">' +
          '<button type="button" class="btn btn-sm btn-ghost" data-action="roster-picker-toggle-all">全選/取消全選</button>' +
          '<button type="button" class="btn btn-sm btn-primary" data-action="roster-picker-add">加入所選（<span class="roster-picker-count">0</span>）</button>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

// 面板一開啟（見下方 toggle-roster-picker 事件）就即時讀取表單目前的學年（`#f-year`，而不是
// rec.schoolYear 或 ui.selectedYear 這種可能過時的值——使用者很可能是在新增表單裡先改了學年下拉
// 選單才要選學生），重新產生班別選項，確保永遠對應使用者「現在」選定的學年，不會因為表單渲染之後
// 又切換學年而顯示錯誤學年的班別。
function populateRosterPickerClasses(wrap){
  var yearEl = document.getElementById('f-year');
  var year = yearEl ? yearEl.value : ui.selectedYear;
  var classes = rosterClassesForYear(year);
  var classSel = wrap.querySelector('.roster-picker-class');
  classSel.innerHTML = '<option value="">請選擇班別</option>' +
    classes.map(function(c){ return '<option value="' + escAttr(c) + '">' + esc(c) + '</option>'; }).join('');
  classSel.value = '';
  var listEl = wrap.querySelector('.roster-picker-list');
  listEl.innerHTML = classes.length
    ? '<div class="ms-option-empty">請先選擇班別</div>'
    : '<div class="ms-option-empty">此學年尚未建立學生名單，可在「學生名單」頁面新增，或繼續用上面的「+ 新增得獎學生」手動輸入</div>';
  updateRosterPickerCount(wrap);
}

// 勾選清單本身：同一班別內，已經出現在這個獎項得獎人清單（班別+姓名完全相符）的學生會顯示「（已
// 加入）」並停用 checkbox，避免重複加入同一位學生兩次；這個「已加入」判斷只看目前這個獎項區塊自己
// 的得獎人清單，不同獎項之間互不影響（同一位學生本來就可能在同一筆記錄底下拿到不同獎項）。
function renderRosterPickerStudentList(wrap, cls){
  var listEl = wrap.querySelector('.roster-picker-list');
  if (!cls){
    listEl.innerHTML = '<div class="ms-option-empty">請先選擇班別</div>';
    updateRosterPickerCount(wrap);
    return;
  }
  var yearEl = document.getElementById('f-year');
  var year = yearEl ? yearEl.value : ui.selectedYear;
  var students = rosterStudentsForClass(year, cls);
  if (!students.length){
    listEl.innerHTML = '<div class="ms-option-empty">此班別暫無學生名單資料</div>';
    updateRosterPickerCount(wrap);
    return;
  }
  var awardBlock = wrap.closest('.award-block');
  var existing = {};
  awardBlock.querySelectorAll('.recipient-row').forEach(function(row){
    var clsEl = row.querySelector('.rec-class'), nmEl = row.querySelector('.rec-name');
    if (!clsEl || !nmEl) return;
    var nm = nmEl.value.trim();
    if (nm) existing[clsEl.value.trim() + '|' + nm] = true;
  });
  listEl.innerHTML = students.map(function(s){
    var already = !!existing[cls + '|' + (s.name || '').trim()];
    return '<label class="ms-option">' +
      '<input type="checkbox" class="roster-picker-student" data-class="' + escAttr(cls) + '" data-no="' + escAttr(s.no || '') + '" data-name="' + escAttr(s.name || '') + '"' + (already ? ' disabled' : '') + '>' +
      esc((s.no ? '(' + s.no + ') ' : '') + s.name) + (already ? '（已加入）' : '') +
    '</label>';
  }).join('');
  updateRosterPickerCount(wrap);
}

function updateRosterPickerCount(wrap){
  var n = wrap.querySelectorAll('.roster-picker-student:checked').length;
  var countEl = wrap.querySelector('.roster-picker-count');
  if (countEl) countEl.textContent = n;
}

// "從課外活動名單選取"：與上面的 rosterPickerHTML 同一個構想，差別是先選
// 課外活動（而不是班別），資料來源是 STATE.clubRosters（見上方
// clubNamesForYear/clubMembersForClub）。一個活動通常橫跨多個班別（不像
// 學生名單選取那樣先選定一個班別），所以名單裡每個成員都要各自顯示班別，
// 不能像學生名單選取那樣把班別放在選單、清單裡只顯示學號＋姓名。同樣需要
// 管理員先在「設定與匯出」頁面的「課外活動名單」建立好資料，此面板才有東西
// 可選；尚未建立資料的活動/學年會顯示提示文字，不影響原本手動輸入的路徑。
function clubPickerHTML(){
  return (
    '<div class="ms-dropdown club-picker">' +
      '<button type="button" class="btn btn-sm" data-action="toggle-club-picker" title="先選課外活動，再勾選多位學生一次加入">從課外活動名單選取</button>' +
      '<div class="ms-panel club-picker-panel" hidden style="width:260px;max-width:80vw">' +
        '<select class="club-picker-club" aria-label="選擇課外活動"><option value="">請選擇課外活動</option></select>' +
        '<div class="club-picker-list ms-options"><div class="ms-option-empty">請先選擇課外活動</div></div>' +
        '<div class="row" style="gap:6px;justify-content:space-between;align-items:center">' +
          '<button type="button" class="btn btn-sm btn-ghost" data-action="club-picker-toggle-all">全選/取消全選</button>' +
          '<button type="button" class="btn btn-sm btn-primary" data-action="club-picker-add">加入所選（<span class="club-picker-count">0</span>）</button>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function populateClubPickerClubs(wrap){
  var yearEl = document.getElementById('f-year');
  var year = yearEl ? yearEl.value : ui.selectedYear;
  var clubs = clubNamesForYear(year);
  var clubSel = wrap.querySelector('.club-picker-club');
  clubSel.innerHTML = '<option value="">請選擇課外活動</option>' +
    clubs.map(function(c){ return '<option value="' + escAttr(c) + '">' + esc(c) + '</option>'; }).join('');
  clubSel.value = '';
  var listEl = wrap.querySelector('.club-picker-list');
  listEl.innerHTML = clubs.length
    ? '<div class="ms-option-empty">請先選擇課外活動</div>'
    : '<div class="ms-option-empty">此學年尚未建立課外活動名單，可在「設定與匯出」頁面新增，或繼續用上面的「+ 新增得獎學生」手動輸入</div>';
  updateClubPickerCount(wrap);
}

function renderClubPickerMemberList(wrap, club){
  var listEl = wrap.querySelector('.club-picker-list');
  if (!club){
    listEl.innerHTML = '<div class="ms-option-empty">請先選擇課外活動</div>';
    updateClubPickerCount(wrap);
    return;
  }
  var yearEl = document.getElementById('f-year');
  var year = yearEl ? yearEl.value : ui.selectedYear;
  var members = clubMembersForClub(year, club);
  if (!members.length){
    listEl.innerHTML = '<div class="ms-option-empty">此活動暫無成員名單資料</div>';
    updateClubPickerCount(wrap);
    return;
  }
  var awardBlock = wrap.closest('.award-block');
  var existing = {};
  awardBlock.querySelectorAll('.recipient-row').forEach(function(row){
    var clsEl = row.querySelector('.rec-class'), nmEl = row.querySelector('.rec-name');
    if (!clsEl || !nmEl) return;
    var nm = nmEl.value.trim();
    if (nm) existing[clsEl.value.trim() + '|' + nm] = true;
  });
  listEl.innerHTML = members.map(function(m){
    var already = !!existing[(m.class||'') + '|' + (m.name || '').trim()];
    return '<label class="ms-option">' +
      '<input type="checkbox" class="club-picker-student" data-class="' + escAttr(m.class || '') + '" data-no="' + escAttr(m.no || '') + '" data-name="' + escAttr(m.name || '') + '"' + (already ? ' disabled' : '') + '>' +
      esc((m.class ? m.class + ' ' : '') + (m.no ? '(' + m.no + ') ' : '') + m.name) + (already ? '（已加入）' : '') +
    '</label>';
  }).join('');
  updateClubPickerCount(wrap);
}

function updateClubPickerCount(wrap){
  var n = wrap.querySelectorAll('.club-picker-student:checked').length;
  var countEl = wrap.querySelector('.club-picker-count');
  if (countEl) countEl.textContent = n;
}

// 「從學生名單選取」「從課外活動名單選取」這兩顆按鈕／面板放在得獎人清單的
// 右側獨立一欄（.picker-col），方便老師一邊選取一邊核對左側已加入的學生名單，
// 不會像以前那樣被姓名欄位越擠越長。同一段標記在 awardBlockHTML 初次渲染、
// 以及下面「切換獎項類型」的 change 事件處理中重建 DOM 時都會用到，抽成共用
// 函式以免兩處寫法各自為政、日後改版時漏改其中一處（跟 hintIcon 的作法一樣）。
function pickerColHTML(){
  return (
    '<div class="picker-col">' +
      rosterPickerHTML() +
      clubPickerHTML() +
    '</div>'
  );
}

// 負責老師: a checkbox per name in STATE.teachers (the settings-managed
// list), pre-checked from the record's existing newline-separated teacher
// string, plus a free-text "其他" field pre-filled with any of that
// record's names that are NOT on the list (so nothing typed before this
// feature existed silently disappears from view when editing).
// Short label for the dropdown's closed-state button, summarizing however
// many known teachers are currently checked. Shared between the initial
// render and the live update on every checkbox change (see the 'change'
// handler below), so the two never drift out of sync.
function teacherSelectionSummary(list){
  if (!list.length) return '請選擇教師（可多選）';
  if (list.length <= 3) return list.join('、');
  return list.slice(0,2).join('、') + ' 等 ' + list.length + ' 位';
}

function teacherFieldHTML(rec){
  var existing = rec ? splitTeacherNames(rec.teacher) : [];
  var known = {};
  STATE.teachers.forEach(function(t){ known[t] = true; });
  var others = existing.filter(function(t){ return !known[t]; });
  var checkedList = STATE.teachers.filter(function(t){ return existing.indexOf(t) !== -1; });
  var summary = teacherSelectionSummary(checkedList);
  var optionsHtml = STATE.teachers.length
    ? STATE.teachers.map(function(t){
        var checked = existing.indexOf(t) !== -1;
        return '<label class="ms-option"><input type="checkbox" class="teacher-check" value="' + escAttr(t) + '"' + (checked ? ' checked' : '') + '> ' + esc(t) + '</label>';
      }).join('')
    : '<div class="ms-option-empty">尚未設定教師名單，可在「設定與匯出」的「教師名單」新增</div>';
  return (
    '<label>負責老師</label>' +
    '<div class="ms-dropdown">' +
      '<button type="button" class="ms-control" data-action="toggle-teacher-dropdown">' +
        '<span class="ms-control-text' + (checkedList.length ? '' : ' placeholder') + '">' + esc(summary) + '</span>' +
        '<span class="ms-caret">▾</span>' +
      '</button>' +
      '<div class="ms-panel" hidden>' +
        (STATE.teachers.length ? '<input type="search" class="ms-search" placeholder="搜尋教師姓名…">' : '') +
        '<div class="ms-options">' + optionsHtml + '</div>' +
      '</div>' +
    '</div>' +
    '<input type="text" id="f-teacher-other" placeholder="其他老師（不在名單內，可用頓號、逗號或換行分隔多位）" value="' + escAttr(others.join('、')) + '" style="margin-top:6px">'
  );
}

function awardBlockHTML(award, recSeq){
  award = award || { name:'', type:'individual', item:'', recipients:[{class:'',no:'',name:''}] };
  var type = award.type === 'team' ? 'team' : (award.type === 'teacher' ? 'teacher' : (award.type === 'school' ? 'school' : 'individual'));
  var isSchool = type === 'school';
  var isTeacher = type === 'teacher';
  var recips = (award.recipients && award.recipients.length) ? award.recipients : [{class:'',no:'',name:''}];
  // 獎項編號：儲存後才會有（新增的空白區塊、或匯入預覽剛加進來的獎項都還沒有），
  // 一經產生就會透過下面兩個隱藏欄位跟著這個區塊走，讓 readAwardsFromForm 在
  // 重新儲存表單時原封不動地帶回去，不會每次儲存就換一個新編號。還沒有編號的
  // 獎項（尚未儲存過）就不顯示這個徽章，避免每個新增的獎項區塊都掛著一句
  // 「編號：儲存後產生」的提示文字，畫面比較乾淨。recSeq（這個獎項所屬記錄的
  // 比賽編號）由呼叫端傳入，讓 formatAwardSeq 能組出「C011-P020」這種能看出
  // 所屬比賽的複合編號——見上方 formatAwardSeq 的說明。
  var seqBadge = (typeof award.seq === 'number')
    ? '<span class="badge badge-muted" title="獎項編號，儲存後即固定不變，方便日後在匯出的 CSV 中對照哪些行屬於同一個獎項；前半段是所屬比賽的編號">編號 ' + formatAwardSeq(award.seq, recSeq) + '</span>'
    : '';
  return (
    '<div class="award-block">' +
      '<input type="hidden" class="award-id-hidden" value="' + escAttr(award.id || '') + '">' +
      '<input type="hidden" class="award-seq-hidden" value="' + (typeof award.seq === 'number' ? award.seq : '') + '">' +
      '<div class="award-block-head">' +
        seqBadge +
        '<div class="field" style="flex:0 0 auto;min-width:150px"><label>項目（如有）' + hintIcon('同一場比賽底下的細項，可連同組別一併填寫（例如「高小組60米賽跑」），沒有分項目的比賽可以留空。') + '</label>' +
          '<input type="text" class="award-item" placeholder="例如：高小組60米賽跑" value="' + escAttr(award.item || '') + '"></div>' +
        '<div class="field"><label class="field-required">獎項名稱' + hintIcon('只需填名次/名銜本身，例如「冠軍」。') + '</label>' +
          '<input type="text" class="award-name" placeholder="例如：冠軍" value="' + escAttr(award.name) + '"></div>' +
        '<div class="field" style="flex:0 0 auto;min-width:130px"><label>類型' + hintIcon('「團體」表示以下學生同隊共同獲得這個獎項；「個人」表示每位學生各自獲得（同一獎項名稱可有多位得獎者）；「學校獎項」的得獎人固定是校方本身，不需要輸入名稱；「教師獎項」用於得獎人是老師而非學生的情況，填寫老師姓名（可新增多筆）。') + '</label>' +
          '<select class="award-type">' +
            '<option value="individual"' + (type==='individual'?' selected':'') + '>個人</option>' +
            '<option value="team"' + (type==='team'?' selected':'') + '>團體</option>' +
            '<option value="school"' + (type==='school'?' selected':'') + '>學校獎項</option>' +
            '<option value="teacher"' + (type==='teacher'?' selected':'') + '>教師獎項</option>' +
          '</select></div>' +
        '<button type="button" class="rm-award-btn" data-action="remove-award-block" title="移除整個獎項">刪除獎項</button>' +
      '</div>' +
      '<div class="award-block-body">' +
        '<div class="recipients-col">' +
          (isSchool
            ? '<div class="hint">得獎人將自動設為「' + esc(STATE.meta.schoolName || '') + '」，不需要輸入。</div>'
            : '<div class="recipients-list">' + recips.map(function(rp){ return recipientRowHTML(rp, isTeacher); }).join('') + '</div>' +
              '<button type="button" class="btn btn-sm" style="margin-top:8px" data-action="add-recipient-row">' + (isTeacher ? '+ 新增得獎老師' : '+ 新增得獎學生') + '</button>') +
        '</div>' +
        ((isSchool || isTeacher) ? '' : pickerColHTML()) +
      '</div>' +
    '</div>'
  );
}

function renderAddView(){
  var rec = ui.editingId ? getRecord(ui.editingId) : null;
  var awards = rec && rec.awards.length ? rec.awards : [{ name:'', type:'individual', item:'', recipients:[{class:'',no:'',name:''}] }];

  // 批次匯入活動記錄的入口特意放在「新增記錄」頁面（而不是「獲獎記錄」列表頁）——
  // 這裡本來就是使用者「要新增活動記錄」時會來的地方，批次匯入是另一種新增方式
  // （一次建立多筆全新記錄），只在「新增」情境（rec 為空，不是在編輯既有記錄）
  // 且管理員登入時顯示；編輯既有記錄時沒有意義，不顯示。
  var bulkImportBlock = (!rec && ui.adminMode) ?
    '<div class="card card-pad stack">' +
      '<div class="row wrap" style="align-items:center;justify-content:space-between;gap:10px">' +
        '<div>' +
          '<div class="section-title" style="margin-bottom:2px">批次匯入活動記錄</div>' +
          '<div class="hint">一次上傳包含多場比賽的 Excel/CSV 檔案，每場比賽會各自建立一筆全新的活動記錄（以「活動名稱＋比賽日期」判斷是否屬於同一場）；若只是新增單一場比賽，直接在下面填寫表單即可。</div>' +
        '</div>' +
        '<div class="row" style="gap:6px;flex:0 0 auto">' +
          '<button type="button" class="btn btn-sm" data-action="open-bulk-import">批次匯入活動記錄</button>' +
          '<button type="button" class="btn btn-sm" data-action="download-bulk-template">下載範本</button>' +
          '<input type="file" id="bulk-import-file-input" accept=".xlsx,.xls,.csv" hidden>' +
        '</div>' +
      '</div>' +
    '</div>'
    : '';

  var adminBlock = '';
  if (ui.adminMode){
    adminBlock =
      '<div class="card card-pad stack">' +
        '<div class="section-title">管理員欄位</div>' +
        '<div class="grid-2">' +
          '<div class="field"><label for="f-admin1">校務處理備註</label>' +
            '<input type="text" id="f-admin1" value="' + escAttr(rec ? rec.admin1 : '') + '"></div>' +
          '<div class="field"><label for="f-admin2">學段 / 優點備註</label>' +
            '<input type="text" id="f-admin2" value="' + escAttr(rec ? rec.admin2 : '') + '"></div>' +
        '</div>' +
        '<label class="check-inline"><input type="checkbox" id="f-needs-review" ' + (rec && rec.needsReview ? 'checked' : '') + '> 標記為待確認</label>' +
        (rec && rec.reviewNote ? '<div class="banner banner-warn">' + esc(rec.reviewNote) + '</div>' : '') +
        (rec && rec.source === 'import' ? '<div class="hint">此記錄由舊版 Excel 匯入' + (rec.sourceRow ? '（原始第 ' + rec.sourceRow + ' 列）' : '') + '。</div>' : '') +
      '</div>';
  }

  return (
    '<div class="stack">' +
    '<form class="stack" id="add-edit-form" novalidate>' +
      '<div id="form-errors" class="banner banner-warn" hidden></div>' +
      '<div class="card card-pad stack">' +
        '<div class="section-title">比賽資料' + (rec && typeof rec.seq === 'number' ? ' <span class="badge badge-muted" style="font-weight:normal;margin-left:6px">比賽編號 ' + formatRecordSeq(rec.seq) + '</span>' : '') + '</div>' +
        '<div class="grid-2">' +
          '<div class="field"><label class="field-required" for="f-subject">科目</label>' +
            '<select id="f-subject">' + subjectOptions(rec ? rec.subject : STATE.subjects[0]) + '</select></div>' +
          '<div class="field"><label class="field-required" for="f-year">學年</label>' +
            '<select id="f-year">' + yearOptionsFor(rec ? rec.schoolYear : ui.selectedYear) + '</select></div>' +
        '</div>' +
        '<div class="grid-2">' +
          '<div class="field"><label class="field-required" for="f-date">比賽日期</label>' +
            '<div style="position:relative">' +
              '<input type="text" id="f-date" placeholder="YYYY-MM-DD" value="' + escAttr(rec ? rec.date : '') + '" style="width:100%;padding-right:34px">' +
              '<div aria-hidden="true" style="position:absolute;top:0;right:0;width:32px;height:100%;display:flex;align-items:center;justify-content:center;color:var(--color-text-muted);pointer-events:none">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>' +
              '</div>' +
              '<input type="date" id="f-date-native" title="選取日期" aria-label="用日曆選擇日期" style="position:absolute;top:0;right:0;width:32px;height:100%;opacity:0;cursor:pointer;border:0;padding:0">' +
            '</div>' +
            '<div class="hint">日期不確定的話，可填文字說明（例如「4月」）；按日曆圖示可用日曆挑選標準日期</div>' +
          '</div>' +
          '<div class="field">' + teacherFieldHTML(rec) + '</div>' +
        '</div>' +
        '<div class="field"><label class="field-required" for="f-event">活動 / 比賽名稱</label>' +
          '<input type="text" id="f-event" value="' + escAttr(rec ? rec.event : '') + '"></div>' +
        '<div class="field"><label class="field-required" for="f-organizer">主辦機構</label>' +
          '<input type="text" id="f-organizer" value="' + escAttr(rec ? rec.organizer : '') + '"></div>' +
      '</div>' +

      '<div class="card card-pad stack">' +
        '<div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap">' +
          '<div class="section-title field-required" style="margin:0">獎項（一個比賽可有多個獎項，每個獎項可有多位得獎學生）' + hintIcon('Excel／CSV 檔案建議包含「獎項」「班別」「學號」「姓名」欄位，第一行為標題（可先下載範本參考格式）。') + '</div>' +
          '<div class="row">' +
            '<button type="button" class="btn btn-sm" data-action="add-award-block">+ 新增獎項</button>' +
            '<button type="button" class="btn btn-sm" data-action="open-import">匯入 Excel</button>' +
            '<button type="button" class="btn btn-sm" data-action="download-award-template">下載範本</button>' +
          '</div>' +
        '</div>' +
        '<div class="awards-editor" id="awards-editor">' + awards.map(function(a){ return awardBlockHTML(a, rec ? rec.seq : undefined); }).join('') + '</div>' +
        '<input type="file" id="import-file-input" accept=".xlsx,.xls,.csv" hidden>' +
      '</div>' +

      bulkImportBlock +

      (ui.adminMode ? adminBlock : '') +

      '<div class="row" style="justify-content:flex-end">' +
        (ui.editingId ? '<button type="button" class="btn" data-action="cancel-edit">取消</button>' : '') +
        '<button type="submit" class="btn btn-primary">' + (ui.editingId ? '更新記錄' : '儲存記錄') + '</button>' +
      '</div>' +
    '</form>' +
    '</div>'
  );
}

/* ============================================================
   Excel / CSV import parsing
   ============================================================ */

function parseCSVText(text){
  var rows = [], row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (var i=0;i<text.length;i++){
    var c = text[i];
    if (inQuotes){
      if (c === '"'){ if (text[i+1] === '"'){ field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ','){ row.push(field); field=''; }
      else if (c === '\r'){ /* skip */ }
      else if (c === '\n'){ row.push(field); rows.push(row); row=[]; field=''; }
      else field += c;
    }
  }
  if (field.length || row.length){ row.push(field); rows.push(row); }
  return rows;
}

// Recognizes an optional "類型" (個人/團體/學校/教師) column alongside the
// required 獎項/班別/學號/姓名 columns. Older import files (and the
// pre-existing template) simply won't have this column — idx.type stays -1
// and every imported award defaults to 'individual', same as the
// manual-entry form. 2026-09-09 新增「學校/教師獎項」辨識：一列只要「類型」欄
// 寫著任何一種學校/教師的說法，這一行的「姓名」欄就會被當成老師姓名或校方
// 名稱讀進 recipients（結構上與學生姓名共用同一個 name 欄位，只是不會有
// 班別/學號——見 groupImportMatrix／groupBulkImportMatrix，這兩者本來就只在
// 有填班別/學號的欄位時才讀，留空不會出錯）。2026-09-19 第十一次更新把「學校/
// 教師獎項」拆成獨立的 'school'／'teacher' 兩種型別後，這裡跟著拆成三種判斷：
// 「學校」「校方」等明確指向學校本身的說法 → 'school'；「教師」「老師」等
// 明確指向老師的說法 → 'teacher'；舊檔案裡可能仍殘留的「學校/教師」這種
// 沒有拆開的合併說法無法單看這欄本身判斷，改用這一列的「姓名」欄來消歧——
// 姓名剛好等於學校全名就當作 'school'，否則當作 'teacher'（多半是填了具體
// 老師姓名），呼叫端（groupImportMatrix／groupBulkImportMatrix）額外傳入
// name 參數就是為了這裡的消歧判斷。
function normalizeImportedAwardType(v, name){
  v = String(v===undefined||v===null?'':v).trim();
  if (v==='團體' || v==='团体' || v.toLowerCase()==='team' || v.toLowerCase()==='group') return 'team';
  var vl = v.toLowerCase();
  if (v==='學校/教師' || v==='学校/教师'){
    var nm = String(name===undefined||name===null?'':name).trim();
    return (nm && nm === (STATE.meta.schoolName||'').trim()) ? 'school' : 'teacher';
  }
  if (v==='學校' || v==='学校' || v==='校方' || v==='學校獎項' || vl==='school') return 'school';
  if (v==='教師' || v==='教师' || v==='老師' || v==='老师' || v==='教師獎項' || vl==='teacher') return 'teacher';
  return 'individual';
}

function detectImportColumns(headerRow){
  var idx = { award:-1, cls:-1, no:-1, name:-1, type:-1, item:-1 };
  headerRow.forEach(function(h,i){
    var v = String(h===undefined||h===null?'':h).trim();
    var lv = v.toLowerCase();
    if (idx.name===-1 && (v.indexOf('姓名')!==-1 || lv==='name' || v==='學生')) idx.name = i;
    else if (idx.no===-1 && (v.indexOf('學號')!==-1 || v.indexOf('編號')!==-1 || lv==='no' || lv==='no.' || lv==='number')) idx.no = i;
    else if (idx.cls===-1 && (v.indexOf('班別')!==-1 || v.indexOf('班')!==-1 || lv==='class')) idx.cls = i;
    else if (idx.type===-1 && (v.indexOf('類型')!==-1 || v.indexOf('类型')!==-1 || v.indexOf('性質')!==-1 || lv==='type')) idx.type = i;
    else if (idx.item===-1 && (v.indexOf('項目')!==-1 || v.indexOf('项目')!==-1 || lv==='item')) idx.item = i;
    else if (idx.award===-1 && (v.indexOf('獎')!==-1 || lv.indexOf('award')!==-1)) idx.award = i;
  });
  return idx;
}

function groupImportMatrix(matrix){
  if (!matrix.length) return [];
  var idx = detectImportColumns(matrix[0]);
  if (idx.name === -1) return []; // can't proceed without at least a name column
  var order = [], byKey = {};
  var lastAward = '', lastItem = '';
  for (var r=1; r<matrix.length; r++){
    var row = matrix[r];
    if (!row) continue;
    var name = idx.name>=0 ? String(row[idx.name]===undefined?'':row[idx.name]).trim() : '';
    if (!name) continue;
    var cls = idx.cls>=0 ? String(row[idx.cls]===undefined?'':row[idx.cls]).trim() : '';
    var no = idx.no>=0 ? String(row[idx.no]===undefined?'':row[idx.no]).trim() : '';
    var awardVal = idx.award>=0 ? String(row[idx.award]===undefined?'':row[idx.award]).trim() : '';
    if (awardVal) lastAward = awardVal; else awardVal = lastAward;
    // 項目 carries forward across blank cells exactly like 獎項 name does —
    // unlike 類型 (below), a blank item cell genuinely means "still under
    // the same item as the row above" (e.g. 冠軍/亞軍/季軍 rows all sitting
    // under one "60米賽跑" item). A file that never fills this column at
    // all just keeps lastItem === '' throughout, which correctly represents
    // a competition with no item divisions.
    var itemVal = idx.item>=0 ? String(row[idx.item]===undefined?'':row[idx.item]).trim() : '';
    if (itemVal) lastItem = itemVal; else itemVal = lastItem;
    // Group by (item, award name) together, not award name alone — otherwise
    // two different items that happen to reuse the same award name (e.g.
    // "冠軍" under both "60米賽跑" and "跳遠") would wrongly merge into one
    // award block.
    var key = itemVal + '␟' + (awardVal || '(未命名)');
    if (!byKey[key]){
      // Type, unlike item, is only read off the FIRST row of a new award
      // group — it's an independent property of that one group, not
      // something that should leak forward from an unrelated earlier award
      // the way the item/award-name cells do. A blank/unrecognized cell on
      // that first row defaults to 'individual'.
      var typeRaw = idx.type>=0 ? String(row[idx.type]===undefined?'':row[idx.type]).trim() : '';
      byKey[key] = { name: awardVal, item: itemVal, type: typeRaw ? normalizeImportedAwardType(typeRaw, name) : 'individual', recipients: [] };
      order.push(key);
    }
    byKey[key].recipients.push({ class: cls, no: no, name: name });
  }
  return order.map(function(k){ return byKey[k]; });
}

/* ============================================================
   批次匯入多筆活動記錄（2026-09-06 第三次修訂，回應「匯入獎項時能否同時輸入多個
   項目及比賽」的要求）
   ------------------------------------------------------------
   上面的 groupImportMatrix／handleImportFile／applyImportGroups 是「新增記錄」表單
   裡的匯入功能，刻意只處理一筆記錄（比賽）底下的多個獎項/項目——匯入結果會附加到
   目前正在編輯的這一筆記錄上。這裡是完全獨立的另一個功能：讓管理員一次上傳一份
   包含多場不同比賽的檔案，每場比賽（活動名稱＋比賽日期視為同一場的識別依據，理由
   與獎項/項目的沿用邏輯相同——每場比賽通常只在第一行填活動資料，後面留空代表
   「還是同一場」）各自建立一筆全新的獎項記錄，不需要先手動建立好記錄外殼再逐一匯入
   獎項。刻意不修改上面既有、已在用的單一記錄匯入路徑，避免任何回歸風險；兩者的
   欄位辨識重疊之處（獎項/項目/類型/班別/學號/姓名）直接重用 detectImportColumns／
   normalizeImportedAwardType，只在此新增活動層級欄位（學年/科目/活動/主辦機構/
   日期/負責老師）的辨識。
   ============================================================ */
function detectBulkEventColumns(headerRow){
  var idx = { schoolYear:-1, subject:-1, event:-1, organizer:-1, date:-1, teacher:-1 };
  headerRow.forEach(function(h,i){
    var v = String(h===undefined||h===null?'':h).trim();
    var lv = v.toLowerCase();
    if (idx.event===-1 && (v.indexOf('活動')!==-1 || v.indexOf('比賽名稱')!==-1 || v.indexOf('賽事')!==-1 || lv==='event')) idx.event = i;
    else if (idx.organizer===-1 && (v.indexOf('主辦')!==-1 || lv==='organizer')) idx.organizer = i;
    else if (idx.date===-1 && (v.indexOf('日期')!==-1 || lv==='date')) idx.date = i;
    else if (idx.teacher===-1 && (v.indexOf('老師')!==-1 || v.indexOf('教師')!==-1 || lv==='teacher')) idx.teacher = i;
    else if (idx.subject===-1 && (v.indexOf('科目')!==-1 || lv==='subject')) idx.subject = i;
    else if (idx.schoolYear===-1 && (v.indexOf('學年')!==-1 || lv==='schoolyear' || lv==='year')) idx.schoolYear = i;
  });
  return idx;
}

function groupBulkImportMatrix(matrix){
  if (!matrix.length) return { records: [], nameFound:false };
  var eventIdx = detectBulkEventColumns(matrix[0]);
  var awardIdx = detectImportColumns(matrix[0]);
  if (awardIdx.name === -1) return { records: [], nameFound:false };

  function cell(row, i){ return i>=0 ? String(row[i]===undefined?'':row[i]).trim() : ''; }

  var recOrder = [], byRecKey = {};
  var last = { schoolYear:'', subject:'', event:'', organizer:'', date:'', teacher:'', award:'', item:'' };
  var currentRecKey = null;
  for (var r=1; r<matrix.length; r++){
    var row = matrix[r];
    if (!row) continue;
    var name = cell(row, awardIdx.name);
    if (!name) continue;

    // schoolYear/event/date define which competition a row belongs to, so
    // they alone carry forward across blank cells (see recKey below).
    var schoolYear = cell(row, eventIdx.schoolYear); if (schoolYear) last.schoolYear = schoolYear; else schoolYear = last.schoolYear;
    var event_ = cell(row, eventIdx.event); if (event_) last.event = event_; else event_ = last.event;
    var date = cell(row, eventIdx.date); if (date) last.date = date; else date = last.date;

    // 一「筆比賽記錄」的分界：學年＋活動名稱＋比賽日期都相同視為同一場比賽的延續列；
    // 只要其中一項換了新值，就代表換到下一場比賽。與獎項/項目的沿用邏輯相同道理，
    // 讓一份直向排列、每場比賽只在第一行填活動資料的檔案可以正確分組，不需要每一行
    // 都重複填寫整場比賽的資料。若檔案完全沒有活動層級欄位，schoolYear/event/date
    // 三者從頭到尾都是空字串，等同全部歸入同一筆記錄——這樣新功能會自然地退化成與
    // 舊有單一記錄匯入相同的行為，而不是強迫使用者一定要提供這些欄位。
    var recKey = schoolYear + '␟' + event_ + '␟' + date;
    if (recKey !== currentRecKey){
      // 換到新的一場比賽：科目/主辦機構/負責老師/獎項/項目的「沿用上一行」狀態
      // 必須在這裡重設，否則上一場比賽最後一行填的值會誤「洩漏」成這一場比賽
      // 第一行留白欄位的預設值（例如上一場填了科目，這一場沒有填科目的話，不應該
      // 被誤判成沿用上一場的科目——這兩場根本是不同的活動）。
      last.subject = ''; last.organizer = ''; last.teacher = ''; last.award = ''; last.item = '';
      currentRecKey = recKey;
    }

    var subject = cell(row, eventIdx.subject); if (subject) last.subject = subject; else subject = last.subject;
    var organizer = cell(row, eventIdx.organizer); if (organizer) last.organizer = organizer; else organizer = last.organizer;
    var teacher = cell(row, eventIdx.teacher); if (teacher) last.teacher = teacher; else teacher = last.teacher;

    var cls = cell(row, awardIdx.cls);
    var no = cell(row, awardIdx.no);
    var awardVal = cell(row, awardIdx.award); if (awardVal) last.award = awardVal; else awardVal = last.award;
    var itemVal = cell(row, awardIdx.item); if (itemVal) last.item = itemVal; else itemVal = last.item;
    var typeRaw = awardIdx.type>=0 ? cell(row, awardIdx.type) : '';

    if (!byRecKey[recKey]){
      byRecKey[recKey] = {
        schoolYear: schoolYear, subject: subject, event: event_, organizer: organizer,
        date: date, teacher: teacher, awardOrder: [], byAwardKey: {}
      };
      recOrder.push(recKey);
    }
    var recGroup = byRecKey[recKey];
    // 同一場比賽稍後的資料列，若填了較早的列沒填的科目/主辦機構/負責老師，仍可以
    // 補上去（有些人只在其中一行填這些欄位，不一定是第一行）——但只補「目前還是
    // 空白」的欄位，不會用空白蓋掉已經有值的資料。
    if (subject && !recGroup.subject) recGroup.subject = subject;
    if (organizer && !recGroup.organizer) recGroup.organizer = organizer;
    if (teacher && !recGroup.teacher) recGroup.teacher = teacher;

    var awardKey = itemVal + '␟' + (awardVal || '(未命名)');
    if (!recGroup.byAwardKey[awardKey]){
      recGroup.byAwardKey[awardKey] = { name: awardVal, item: itemVal, type: typeRaw ? normalizeImportedAwardType(typeRaw, name) : 'individual', recipients: [] };
      recGroup.awardOrder.push(awardKey);
    }
    recGroup.byAwardKey[awardKey].recipients.push({ class: cls, no: no, name: name });
  }

  var records = recOrder.map(function(k){
    var g = byRecKey[k];
    return {
      schoolYear: g.schoolYear, subject: g.subject, event: g.event,
      organizer: g.organizer, date: g.date, teacher: g.teacher,
      awards: g.awardOrder.map(function(ak){ return g.byAwardKey[ak]; })
    };
  });
  return { records: records, nameFound:true };
}

function handleBulkImportFile(file){
  readSpreadsheetMatrix(file, function(matrix){
    var parsed = groupBulkImportMatrix(matrix);
    if (!parsed.nameFound){ showToast('無法辨識姓名欄位，請確認欄位包含「姓名」'); return; }
    var missingSubjectCount = parsed.records.filter(function(r){ return !r.subject; }).length;
    var missingEventCount = parsed.records.filter(function(r){ return !r.event; }).length;
    ui.modal = {
      type: 'bulk-import-preview', records: parsed.records, fileName: file.name,
      missingSubjectCount: missingSubjectCount, missingEventCount: missingEventCount
    };
    renderModal();
  }, showToast);
}

function downloadBulkImportTemplate(){
  var rows = [
    ['學年', '科目', '活動/比賽名稱', '主辦機構', '比賽日期', '負責老師', '項目', '獎項', '類型', '班別', '學號', '姓名'],
    ['2026-2027', '體育科', '陸運會', '學校', '2026-11-01', '陳志紅', '高小組60米賽跑', '冠軍', '個人', '5A', '12', '陳小明'],
    ['', '', '', '', '', '', '', '亞軍', '個人', '5A', '18', '李小華'],
    ['', '', '', '', '', '', '高小組接力賽', '亞軍', '團體', '6B', '3', '黃小芳'],
    ['', '', '', '', '', '', '', '', '', '6B', '9', '林大文'],
    ['2026-2027', '常識科', '朗誦比賽', '教育局', '2026-11-15', '楊美貞', '', '優異獎', '個人', '6A', '5', '王小美'],
    ['2026-2027', '音樂科', '校際音樂節', '香港學校音樂及朗誦協會', '2026-12-01', '楊美貞', '', '最佳指導老師獎', '教師', '', '', '楊美貞老師'],
    ['2026-2027', '中文科', '全民國家安全教育日', '香港升旗總會', '2026-04-15', '李潔欣', '', '積極參與獎', '學校', '', '', STATE.meta.schoolName || '樂華天主教小學']
  ];
  downloadCSV('批次匯入活動記錄範本.csv', rows, '已下載範本（可用 Excel 開啟）');
}

function handleImportFile(file){
  var isCSV = /\.csv$/i.test(file.name);
  var reader = new FileReader();
  reader.onerror = function(){ showToast('讀取檔案失敗，請重試'); };
  reader.onload = function(e){
    try{
      var matrix;
      if (isCSV){
        matrix = parseCSVText(String(e.target.result));
      } else {
        if (!window.XLSX){ showToast('Excel 解析元件未能載入，請稍後重試，或改用 CSV 檔案'); return; }
        var wb = XLSX.read(new Uint8Array(e.target.result), { type:'array' });
        var sheet = wb.Sheets[wb.SheetNames[0]];
        matrix = XLSX.utils.sheet_to_json(sheet, { header:1, defval:'' });
      }
      var groups = groupImportMatrix(matrix);
      ui.modal = { type:'import', groups: groups, fileName: file.name };
      renderModal();
    }catch(err){
      showToast('無法解析此檔案：' + (err && err.message ? err.message : '格式錯誤'));
    }
  };
  if (isCSV) reader.readAsText(file, 'utf-8'); else reader.readAsArrayBuffer(file);
}

function applyImportGroups(groups){
  var editor = document.getElementById('awards-editor');
  if (!editor) return;
  // 注意：不可直接寫成 groups.map(awardBlockHTML)，Array.prototype.map 會把
  // (element, index, array) 三個參數都傳入回呼函式，awardBlockHTML 的第二個
  // 參數目前意義是 recSeq（所屬比賽編號），若直接傳入會誤把陣列索引當成
  // recSeq。這裡的獎項都是剛匯入、尚未有 award.seq 的新資料，徽章本來就不會
  // 顯示，所以先前是無害的，但仍以明確寫法避免日後擴充時出錯。
  var rec = ui.editingId ? getRecord(ui.editingId) : null;
  var recSeq = rec ? rec.seq : undefined;
  editor.insertAdjacentHTML('beforeend', groups.map(function(g){ return awardBlockHTML(g, recSeq); }).join(''));
}

/* ============================================================
   List view
   ============================================================ */

// Year / subject / month / review-flag filters only — no free-text search.
// Shared by every grouping mode so the record universe (before search) is
// always consistent. `skipMonth` lets callers get the pre-month-filter set
// (used to count how many records in scope have a date the月份篩選 can't
// parse — see extractMonthFromDate — without recursively duplicating the
// other filter conditions).
function matchesStructuralFilters(rec, skipMonth){
  if (rec.schoolYear !== ui.selectedYear) return false;
  if (ui.listSubject !== 'all' && rec.subject !== ui.listSubject) return false;
  if (ui.listOnlyReview && !rec.needsReview) return false;
  if (!skipMonth && ui.listMonth !== 'all' && extractMonthFromDate(rec.date) !== ui.listMonth) return false;
  return true;
}

// Broad free-text search across a whole record (event/organizer/award
// names/teacher/subject/any recipient's name or class). Used as-is for
// 科目/教師 grouping. NOT used for 學生 grouping, where a search should
// only surface that student's own entries — see renderStudentGroupedResults.
function matchesTextSearch(rec, q){
  if (!q) return true;
  var awardNames = (rec.awards||[]).map(function(a){ return a.name; }).join(' ');
  var hay = [rec.event, rec.organizer, awardNames, rec.teacher, rec.subject].join(' ').toLowerCase();
  if (hay.indexOf(q) !== -1) return true;
  return (rec.awards||[]).some(function(a){
    return (a.recipients||[]).some(function(rp){
      return (rp.name||'').toLowerCase().indexOf(q) !== -1 || (rp.class||'').toLowerCase().indexOf(q) !== -1;
    });
  });
}

var LIST_GROUP_OPTIONS = [
  { id:'subject', label:'按科目' },
  { id:'student', label:'按學生' },
  { id:'teacher', label:'按教師' },
];

// Distinct teacher names among structurally-filtered records for the
// current year/subject/review scope (used to populate the 按教師 dropdown —
// records only appear once a teacher is actually picked).
function distinctTeachersForFilter(structural){
  var set = {}; var hasBlank = false;
  structural.forEach(function(rec){
    var names = splitTeacherNames(rec.teacher);
    if (!names.length) hasBlank = true;
    names.forEach(function(t){ set[t] = true; });
  });
  var list = Object.keys(set).sort(function(a,b){ return a.localeCompare(b, 'zh-Hant'); });
  if (hasBlank) list.push('（未填負責老師）');
  return list;
}

// Distinct classes among recipients in structurally-filtered records (used
// to populate the 按學生 class dropdown).
function distinctClassesForFilter(structural){
  var set = {};
  structural.forEach(function(rec){
    (rec.awards||[]).forEach(function(a){
      (a.recipients||[]).forEach(function(rp){
        var c = (rp.class||'').trim();
        if (c) set[c] = true;
      });
    });
  });
  return Object.keys(set).sort(function(a,b){ return a.localeCompare(b, 'zh-Hant'); });
}

// Distinct recipient names within a given class (used to populate the
// 按學生 name dropdown once a class has been picked — scoping to a class
// disambiguates students who happen to share a name in different classes).
function distinctNamesForClass(structural, cls){
  var set = {};
  structural.forEach(function(rec){
    (rec.awards||[]).forEach(function(a){
      (a.recipients||[]).forEach(function(rp){
        var name = (rp.name||'').trim();
        if (name && (rp.class||'').trim() === cls) set[name] = true;
      });
    });
  });
  return Object.keys(set).sort(function(a,b){ return a.localeCompare(b, 'zh-Hant'); });
}

function renderListView(){
  var groupTabsHtml = LIST_GROUP_OPTIONS.map(function(opt){
    var active = ui.listGroupBy === opt.id;
    return '<button type="button" class="btn btn-sm' + (active?' btn-primary':' btn-ghost') + '" data-action="set-list-groupby" data-groupby="' + opt.id + '">' + esc(opt.label) + '</button>';
  }).join('');

  // 明確包一層 function——Array.prototype.filter 會把 (element, index, array)
  // 都傳給 callback，若直接傳 matchesStructuralFilters 本身，第二個參數
  // (index) 會被誤當成 skipMonth 用（index >= 1 時恆為 truthy），導致月份篩選
  // 對除第一筆外的所有記錄都被跳過。這是專案中重複出現過的 .map/.filter(fn)
  // 陷阱，這裡刻意包一層避免。
  var structural = STATE.records.filter(function(r){ return matchesStructuralFilters(r); });
  var extraFilterHtml = '';
  if (ui.listGroupBy === 'teacher'){
    var teachers = distinctTeachersForFilter(structural);
    extraFilterHtml =
      '<select id="list-teacher-filter">' +
        '<option value="">請選擇教師…</option>' +
        teachers.map(function(t){ return '<option value="' + escAttr(t) + '"' + (ui.listTeacherFilter===t?' selected':'') + '>' + esc(t) + '</option>'; }).join('') +
      '</select>';
  } else if (ui.listGroupBy === 'student'){
    var classes = distinctClassesForFilter(structural);
    var names = ui.listStudentClass ? distinctNamesForClass(structural, ui.listStudentClass) : [];
    extraFilterHtml =
      '<select id="list-student-class-filter">' +
        '<option value="">請選擇班別…</option>' +
        classes.map(function(c){ return '<option value="' + escAttr(c) + '"' + (ui.listStudentClass===c?' selected':'') + '>' + esc(c) + '</option>'; }).join('') +
      '</select>' +
      '<select id="list-student-name-filter"' + (ui.listStudentClass ? '' : ' disabled') + '>' +
        '<option value="">' + (ui.listStudentClass ? '請選擇學生…' : '先選擇班別') + '</option>' +
        names.map(function(n){ return '<option value="' + escAttr(n) + '"' + (ui.listStudentName===n?' selected':'') + '>' + esc(n) + '</option>'; }).join('') +
      '</select>';
  }

  var searchHtml = ui.listGroupBy === 'teacher'
    ? ''
    : '<input type="search" id="list-search" placeholder="' + (ui.listGroupBy === 'student' ? '搜尋學生姓名…' : '搜尋活動、獎項、學生、班別、老師…') + '" value="' + escAttr(ui.listSearch) + '">';

  var monthOptions = '<option value="all">全部月份</option>';
  for (var mIdx = 1; mIdx <= 12; mIdx++){
    var mVal = String(mIdx).padStart(2, '0');
    monthOptions += '<option value="' + mVal + '"' + (ui.listMonth===mVal?' selected':'') + '>' + mIdx + '月</option>';
  }
  var monthHtml = '<select id="list-month-filter">' + monthOptions + '</select>';

  // 「無法辨識月份」提示：只在有揀選特定月份時才計算並顯示，避免平時多一行雜訊。
  // 用 skipMonth=true 取得「年份／科目／待確認」已篩選、但未套用月份篩選的集合，
  // 才能準確數出「不是這個月、但其實是因為日期格式無法辨識」的記錄數。
  var unknownDateHint = '';
  if (ui.listMonth !== 'all'){
    var preMonthRecs = STATE.records.filter(function(r){ return matchesStructuralFilters(r, true); });
    var unknownCount = preMonthRecs.filter(function(r){ return !extractMonthFromDate(r.date); }).length;
    if (unknownCount > 0){
      unknownDateHint = '<div class="hint" style="margin-top:2px">另有 ' + unknownCount + ' 項活動因日期格式無法自動辨識月份（如「4月」以外的不規則寫法或未填日期），已從月份篩選結果中排除；選「全部月份」可查看全部。</div>';
    }
  }

  return (
    '<div class="stack">' +
      '<div class="row wrap" style="align-items:center;justify-content:space-between">' +
        '<div class="row" style="gap:6px">' + groupTabsHtml + '</div>' +
      '</div>' +
      '<div class="filter-bar">' +
        searchHtml +
        extraFilterHtml +
        '<select id="list-subject-filter">' +
          '<option value="all">全部科目</option>' +
          STATE.subjects.map(function(s){ return '<option value="' + escAttr(s) + '"' + (ui.listSubject===s?' selected':'') + '>' + esc(s) + '</option>'; }).join('') +
        '</select>' +
        monthHtml +
        (ui.adminMode ? '<label class="check-inline"><input type="checkbox" id="list-only-review" ' + (ui.listOnlyReview?'checked':'') + '> 只顯示待確認</label>' : '') +
      '</div>' +
      unknownDateHint +
      '<div id="list-results">' + renderListResults() + '</div>' +
    '</div>'
  );
}

function buildRecordRow(rec){
  var expanded = ui.expandedId === rec.id;
  var count = recipientCount(rec);
  var awardNames = (rec.awards||[]).map(function(a){ return a.name || '（未命名獎項）'; }).join('、');
  var mainRow =
    '<tr class="rec-row" data-id="' + escAttr(rec.id) + '" data-action="toggle-expand" style="cursor:pointer">' +
      '<td class="cell-muted">' + esc(displayDate(rec.date)) + '</td>' +
      '<td class="cell-event">' + (typeof rec.seq === 'number' ? '<span class="cell-muted">' + formatRecordSeq(rec.seq) + '</span> ' : '') + esc(rec.event) +
        (rec.needsReview ? ' <span class="badge badge-warn">待確認</span>' : '') +
        '<div class="event-sub">' + esc(awardNames) + (rec.organizer ? ' · ' + esc(rec.organizer) : '') + '</div>' +
      '</td>' +
      '<td>' + awardCount(rec) + ' 個獎項 · ' + count + ' 人</td>' +
      // record.teacher 儲存格式是「每行一位老師姓名」（見上方「負責老師」專節），這裡若直接把
      // 整段字串塞進 <td>（沒有 white-space:pre-wrap 的一般文字節點），瀏覽器會把換行當成一般
      // 空白摺疊，畫面上會看不出這是幾位老師的姓名連在一起——改用 splitTeacherNames 拆開後
      // 用「、」重新接起來（與 teacherSelectionSummary 等其他多位老師顯示位置一致的分隔符）。
      '<td class="cell-muted">' + esc(splitTeacherNames(rec.teacher).join('、')) + '</td>' +
      '<td class="cell-actions">' +
        '<button class="btn btn-sm btn-ghost" type="button" data-action="edit-record" data-id="' + escAttr(rec.id) + '">編輯</button>' +
        (ui.deleteConfirmId === rec.id ?
          '<button class="btn btn-sm btn-danger" type="button" data-action="confirm-delete" data-id="' + escAttr(rec.id) + '">確定刪除</button>' +
          '<button class="btn btn-sm btn-ghost" type="button" data-action="cancel-delete">取消</button>'
          :
          '<button class="btn btn-sm btn-ghost btn-danger" type="button" data-action="ask-delete" data-id="' + escAttr(rec.id) + '">刪除</button>') +
      '</td>' +
    '</tr>';

  var detailRow = '';
  if (expanded){
    var groupsHtml = (rec.awards||[]).map(function(a){
      var isSchoolAward = a.type === 'school';
      var isTeacherAward = a.type === 'teacher';
      var chips = (a.recipients||[]).map(function(rp){
        // 學校獎項／教師獎項的得獎人沒有班別/學號可顯示（見上方 recipientRowHTML／
        // computeStats 的說明），直接顯示名稱本身，不要印出一個沒有意義的「—」。
        if (isSchoolAward || isTeacherAward) return '<span class="recipient-chip">' + esc(rp.name) + '</span>';
        // 2026-09-19 第十三次更新：得獎人顯示格式統一為「班別(學號) 姓名」（例如
        // 「1D(24) 沈洛瑩」），取代先前的「班別 #學號 姓名」（class 粗體、no 前綴
        // 「#」）寫法；沒有學號時不顯示括號，直接「班別 姓名」。
        return '<span class="recipient-chip">' + esc(rp.class||'—') +
          (rp.no ? '(' + esc(rp.no) + ')' : '') +
          ' ' + esc(rp.name) + '</span>';
      }).join('');
      var typeBadge = isSchoolAward
        ? '<span class="badge badge-accent">學校</span>'
        : isTeacherAward
          ? '<span class="badge badge-accent">教師</span>'
          : '<span class="badge ' + (a.type==='team'?'badge-accent':'badge-muted') + '">' + (a.type==='team'?'團體':'個人') + '</span>';
      var itemBadge = a.item ? '<span class="badge badge-muted">' + esc(a.item) + '</span> ' : '';
      var awardSeqBadge = (typeof a.seq === 'number') ? '<span class="cell-muted">' + formatAwardSeq(a.seq, rec.seq) + '</span> ' : '';
      return '<div class="award-group">' +
        '<div class="award-group-name">' + awardSeqBadge + itemBadge + esc(a.name || '（未命名獎項）') + '（' + (a.recipients||[]).length + ' 人）' + ' ' + typeBadge + '</div>' +
        '<div class="recipient-chip-list">' + (chips || '<span class="cell-muted">未有學生資料</span>') + '</div>' +
      '</div>';
    }).join('');
    var adminInfo = '';
    if (ui.adminMode){
      adminInfo = '<div class="grid-2" style="margin-top:12px">' +
        '<div><div class="section-title">校務處理備註</div><div>' + esc(rec.admin1 || '—') + '</div></div>' +
        '<div><div class="section-title">學段 / 優點備註</div><div>' + esc(rec.admin2 || '—') + '</div></div>' +
      '</div>' +
      (rec.reviewNote ? '<div class="banner banner-warn" style="margin-top:10px">' + esc(rec.reviewNote) + '</div>' : '');
    }
    detailRow =
      '<tr><td colspan="5" style="padding:0">' +
        '<div class="expand-panel">' + groupsHtml + adminInfo + '</div>' +
      '</td></tr>';
  }
  return mainRow + detailRow;
}

// Used by both the 科目 and 教師 groupings: each group's rows are whole
// records (a record belongs to exactly one subject, and to one or more
// teachers via its newline-separated teacher field).
function renderRecordGroupSection(label, recs){
  var rowsHtml = recs.map(buildRecordRow).join('');
  return (
    '<div class="subject-section">' +
      '<div class="subject-section-head">' +
        '<h3>' + esc(label) + '</h3>' +
        '<span class="badge badge-accent">' + recs.length + ' 項活動</span>' +
      '</div>' +
      '<div class="table-wrap"><table class="data">' +
        '<thead><tr><th>日期</th><th>活動 / 比賽</th><th>獎項/人數</th><th>負責老師</th><th></th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table></div>' +
    '</div>'
  );
}

// Groups whole records by subject (canonical STATE.subjects order). 按教師
// and 按學生 are each scoped down to a single selected teacher/student
// directly in renderListResults, so this is only used for 按科目 now.
function groupRecordsBy(filtered, mode){
  var bySubject = {};
  filtered.forEach(function(r){ (bySubject[r.subject] = bySubject[r.subject] || []).push(r); });
  var orderedSubjects = STATE.subjects.filter(function(s){ return bySubject[s] && bySubject[s].length; });
  Object.keys(bySubject).forEach(function(s){ if (orderedSubjects.indexOf(s) === -1) orderedSubjects.push(s); });
  return orderedSubjects.map(function(s){ return { label:s, records:bySubject[s] }; });
}

// The 學生 grouping is per-recipient rather than per-record: a single
// record can carry many different students (each possibly winning a
// different award within it), so each matched student gets a compact
// award-entry table rather than the full buildRecordRow used elsewhere.
// `q` (free-text, from the search box) matches the recipient's own name
// only — not any other field on the record — so classmates who happen to
// share a record with the searched student don't show up too. `exact`
// ({class, name}, from the class+name dropdowns) narrows to one specific
// student — the class disambiguates students who share a name across
// different classes. Exactly one of q / exact is expected to be active.
function renderStudentGroupedResults(filtered, q, exact){
  var byStudent = {};
  filtered.forEach(function(rec){
    (rec.awards || []).forEach(function(a){
      // 學校獎項／教師獎項的「得獎人」是校名或老師姓名，不是學生——見
      // computeStats 同樣排除邏輯的說明，這裡道理一致：不能讓老師姓名混進
      // 「按學生」列表。
      if (a.type === 'school' || a.type === 'teacher') return;
      (a.recipients || []).forEach(function(rp){
        var name = (rp.name || '').trim();
        if (!name) return;
        if (exact){
          if (name !== exact.name || (rp.class||'').trim() !== exact.class) return;
        } else if (q && name.toLowerCase().indexOf(q) === -1) {
          return;
        }
        (byStudent[name] = byStudent[name] || []).push({ rec:rec, award:a, rp:rp });
      });
    });
  });
  var names = Object.keys(byStudent).sort(function(a,b){ return a.localeCompare(b, 'zh-Hant'); });
  if (!names.length){
    return '<div class="card empty-state"><h3>沒有符合的學生獲獎記錄</h3><div>試試調整搜尋字詞、篩選條件，或切換學年。</div></div>';
  }
  return names.map(function(name){
    var entries = byStudent[name].slice().sort(function(x,y){ return (y.rec.date||'').localeCompare(x.rec.date||''); });
    var rowsHtml = entries.map(function(en){
      var awardLabel = (en.award.item ? '<span class="badge badge-muted">' + esc(en.award.item) + '</span> ' : '') +
        esc(en.award.name || '') + (en.award.type === 'team' ? ' <span class="badge badge-accent">團體</span>' : '');
      return '<tr><td class="cell-muted">' + esc(displayDate(en.rec.date)) + '</td><td>' + esc(en.rec.subject) + '</td>' +
        '<td class="cell-event">' + esc(en.rec.event) + '</td><td>' + awardLabel + '</td>' +
        '<td class="cell-muted">' + esc(en.rp.class || '') + (en.rp.no ? ' #' + esc(en.rp.no) : '') + '</td></tr>';
    }).join('');
    return (
      '<div class="subject-section">' +
        '<div class="subject-section-head">' +
          '<h3>' + esc(name) + '</h3>' +
          '<span class="badge badge-accent">' + entries.length + ' 項獲獎</span>' +
        '</div>' +
        '<div class="table-wrap"><table class="data">' +
          '<thead><tr><th>日期</th><th>科目</th><th>活動 / 比賽</th><th>獎項</th><th>班別</th></tr></thead>' +
          '<tbody>' + rowsHtml + '</tbody>' +
        '</table></div>' +
      '</div>'
    );
  }).join('');
}

function renderListResults(){
  var q = ui.listSearch.trim().toLowerCase();
  var yearTotal = recordsForYear(ui.selectedYear).length;
  // 明確包一層 function——Array.prototype.filter 會把 (element, index, array)
  // 都傳給 callback，若直接傳 matchesStructuralFilters 本身，第二個參數
  // (index) 會被誤當成 skipMonth 用（index >= 1 時恆為 truthy），導致月份篩選
  // 對除第一筆外的所有記錄都被跳過。這是專案中重複出現過的 .map/.filter(fn)
  // 陷阱，這裡刻意包一層避免。
  var structural = STATE.records.filter(function(r){ return matchesStructuralFilters(r); });

  if (ui.listGroupBy === 'teacher'){
    // Records only show once a specific teacher is picked from the dropdown.
    if (!ui.listTeacherFilter){
      return '<div class="card empty-state"><h3>請先選擇教師</h3><div>在上方下拉式選單揀選一位教師，即可查看其負責的獲獎記錄。</div></div>';
    }
    var teacherRecs = structural.filter(function(rec){
      var names = splitTeacherNames(rec.teacher);
      if (ui.listTeacherFilter === '（未填負責老師）') return names.length === 0;
      return names.indexOf(ui.listTeacherFilter) !== -1;
    });
    if (!teacherRecs.length){
      return '<div class="card empty-state"><h3>沒有符合的記錄</h3><div>試試調整篩選條件，或切換學年。</div></div>';
    }
    var teacherRecsSorted = teacherRecs.slice().sort(function(a,b){ return (b.date||'').localeCompare(a.date||''); });
    return (
      renderRecordGroupSection(ui.listTeacherFilter, teacherRecsSorted) +
      '<div class="hint" style="margin-top:2px">顯示 ' + teacherRecs.length + ' / ' + yearTotal + ' 項活動（' + esc(ui.selectedYear) + '）</div>'
    );
  }

  if (ui.listGroupBy === 'student'){
    // Records only show once the user has either searched a name, or
    // picked both a class and a name from the dropdowns.
    var exact = (ui.listStudentClass && ui.listStudentName) ? { class: ui.listStudentClass, name: ui.listStudentName } : null;
    if (!q && !exact){
      return '<div class="card empty-state"><h3>請選擇班別及姓名，或直接搜尋</h3><div>在上方選擇班別、再選擇學生姓名，或在搜尋框輸入學生姓名，即可查看該學生的獲獎記錄。</div></div>';
    }
    if (!structural.length){
      return '<div class="card empty-state"><h3>沒有符合的記錄</h3><div>試試調整篩選條件，或切換學年。</div></div>';
    }
    var studentBody = renderStudentGroupedResults(structural, q, exact);
    var entryCount = 0;
    var seen = {};
    structural.forEach(function(rec){
      (rec.awards||[]).forEach(function(a){
        (a.recipients||[]).forEach(function(rp){
          var name = (rp.name||'').trim();
          if (!name) return;
          if (exact){
            if (name !== exact.name || (rp.class||'').trim() !== exact.class) return;
          } else if (q && name.toLowerCase().indexOf(q) === -1) {
            return;
          }
          entryCount++;
          seen[name] = true;
        });
      });
    });
    var studentCount = Object.keys(seen).length;
    return (
      studentBody +
      '<div class="hint" style="margin-top:2px">顯示 ' + studentCount + ' 位學生、共 ' + entryCount + ' 項獲獎記錄（' + esc(ui.selectedYear) + '）</div>'
    );
  }

  var filtered = structural.filter(function(rec){ return matchesTextSearch(rec, q); });

  if (!filtered.length){
    return '<div class="card empty-state"><h3>沒有符合的記錄</h3><div>試試調整搜尋字詞、篩選條件，或切換學年。</div></div>';
  }

  var groups = groupRecordsBy(filtered, ui.listGroupBy);
  var bodyHtml = groups.map(function(g){
    var recs = g.records.slice().sort(function(a,b){ return (b.date||'').localeCompare(a.date||''); });
    return renderRecordGroupSection(g.label, recs);
  }).join('');

  return (
    bodyHtml +
    '<div class="hint" style="margin-top:2px">顯示 ' + filtered.length + ' / ' + yearTotal + ' 項活動（' + esc(ui.selectedYear) + '）</div>'
  );
}

/* ============================================================
   Students view (admin only): cross-year lookup + roster management
   ============================================================ */

function renderStudentSearchResults(){
  var q = ui.studentSearch.trim();
  if (!q) return '<div class="hint">輸入姓名或學生編號，查詢該學生在所有學年的獲獎記錄。</div>';
  var identities = studentIdentities(q);
  if (!identities.length) return '<div class="cell-muted">找不到符合「' + esc(q) + '」的學生。</div>';
  return identities.map(function(identity){
    var h = studentHistory(identity);
    var displayName = identity.names.join(' / ');
    var rosterHtml = h.roster.length
      ? h.roster.map(function(r){
          return '<span class="badge badge-muted">' + esc(r.schoolYear) + ' ' + esc(r.class || '—') +
            (r.no ? ' #' + esc(r.no) : '') + (r.name !== displayName ? ' ' + esc(r.name) : '') + '</span>';
        }).join(' ')
      : '<span class="cell-muted">名單中未有此學生的班別記錄</span>';
    var entriesHtml = h.entries.length
      ? '<div class="table-wrap"><table class="data"><thead><tr><th>學年</th><th>日期</th><th>科目</th><th>活動 / 比賽</th><th>獎項</th><th>班別</th></tr></thead><tbody>' +
          h.entries.map(function(e){
            return '<tr><td class="cell-muted">' + esc(e.year) + '</td><td class="cell-muted">' + esc(displayDate(e.date)) + '</td><td>' + esc(e.subject) + '</td>' +
              '<td class="cell-event">' + esc(e.event) + '</td><td>' + esc(e.awardName || '') + '</td>' +
              '<td class="cell-muted">' + esc(e.cls || '') + (e.no ? ' #' + esc(e.no) : '') + '</td></tr>';
          }).join('') +
        '</tbody></table></div>'
      : '<div class="cell-muted">暫無獲獎記錄</div>';
    return (
      '<div class="card card-pad stack" style="margin-top:10px">' +
        '<div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap">' +
          '<h3 style="font-size:15px">' + esc(displayName) +
            (identity.studentNo ? ' <span class="badge badge-accent">學生編號 ' + esc(identity.studentNo) + '</span>' : ' <span class="badge badge-warn">名單中無此學生的編號，僅按姓名配對</span>') +
          '</h3>' +
          '<div class="row wrap">' + rosterHtml + '</div>' +
        '</div>' +
        '<div><span class="badge badge-accent">共 ' + h.entries.length + ' 項獲獎記錄</span></div>' +
        entriesHtml +
      '</div>'
    );
  }).join('');
}

function rosterRowHTML(r){
  return (
    '<tr data-id="' + escAttr(r.id) + '">' +
      '<td class="cell-muted">' + esc(r.studentNo || '—') + '</td>' +
      '<td>' + esc(r.class || '') + '</td>' +
      '<td>' + esc(r.no || '') + '</td>' +
      '<td>' + esc(r.name) + '</td>' +
      '<td class="cell-muted">' + esc(r.gender || '') + '</td>' +
      '<td class="cell-muted">' + esc(r.dob || '') + '</td>' +
      '<td class="cell-actions">' +
        (ui.rosterDeleteConfirmId === r.id
          ? '<button class="btn btn-sm btn-danger" type="button" data-action="confirm-remove-roster" data-id="' + escAttr(r.id) + '">確定刪除</button>' +
            '<button class="btn btn-sm btn-ghost" type="button" data-action="cancel-remove-roster">取消</button>'
          : '<button class="btn btn-sm btn-ghost btn-danger" type="button" data-action="ask-remove-roster" data-id="' + escAttr(r.id) + '">刪除</button>') +
      '</td>' +
    '</tr>'
  );
}

// 學生名單管理表格每頁顯示的筆數。名單可能有 600 筆以上（見「第五次更新」／「新增
// 2026-2027 學年名單」等），一次全部列出會讓頁面非常長，改為分頁顯示（見
// renderRosterSection／'roster-prev-page'／'roster-next-page' 三處配合使用）。
var ROSTER_PAGE_SIZE = 50;

function renderRosterSection(){
  var year = ui.rosterYear || ui.selectedYear;
  var roster = studentRosterForYear(year).slice().sort(function(a,b){
    return (a.class||'').localeCompare(b.class||'') || String(a.no||'').localeCompare(String(b.no||''), undefined, {numeric:true});
  });
  var yearOptions = STATE.schoolYears.map(function(y){
    return '<option value="' + escAttr(y) + '"' + (y===year?' selected':'') + '>' + esc(y) + '</option>';
  }).join('');
  var years = sortedSchoolYears();
  var canCopy = years.indexOf(year) > 0;

  // 夾住目前頁碼：資料筆數可能因新增/刪除/匯入而改變（尤其 saveAndPublish 後整頁
  // 重新載入，ui.rosterPage 會重設回 1，但保險起見這裡仍夾一次，避免例如切換學年
  // 後停留在一個超出範圍的頁碼、看到空白表格）。
  var totalPages = Math.max(1, Math.ceil(roster.length / ROSTER_PAGE_SIZE));
  if (ui.rosterPage > totalPages) ui.rosterPage = totalPages;
  if (ui.rosterPage < 1) ui.rosterPage = 1;
  var pageStart = (ui.rosterPage - 1) * ROSTER_PAGE_SIZE;
  var pageRoster = roster.slice(pageStart, pageStart + ROSTER_PAGE_SIZE);

  return (
    '<div class="card card-pad stack">' +
      '<div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap">' +
        '<div class="section-title" style="margin:0">學生名單管理' + hintIcon('匯入的 Excel／CSV 需包含「學生編號」（主鍵，用作跨學年識別同一學生）、「班別」「學號」「姓名」「性別」「出生日期」六欄，第一行為標題（可先下載範本參考格式）。「匯入名單」只會新增/更新檔案內的學生，不會動其他學生；「同步名單」則會把檔案當成該學年的完整最新名單——新增插班生、更新資料有變的學生，並移除名單中不在檔案內的學生（視為已離校/退學），套用前會先顯示預覽讓你確認。「學生編號」是跨學年識別同一學生的主鍵；名單用作查詢學生獲獎記錄、核對班別/學號，並不會影響已記錄的獲獎資料本身。') + '</div>' +
        '<div class="row wrap">' +
          '<select id="roster-year-select">' + yearOptions + '</select>' +
          (canCopy ? '<button type="button" class="btn btn-sm" data-action="copy-previous-roster">帶入上一學年名單</button>' : '') +
          '<button type="button" class="btn btn-sm" data-action="open-roster-import">匯入名單</button>' +
          '<button type="button" class="btn btn-sm" data-action="open-roster-sync" title="以此檔案作為完整最新名單：新增/更新檔案內的學生，並移除名單中已離校/退學（不在檔案內）的學生">同步名單（處理退學/插班）</button>' +
          '<button type="button" class="btn btn-sm" data-action="download-roster-template">下載範本</button>' +
        '</div>' +
      '</div>' +
      '<form class="row wrap" id="add-roster-form">' +
        '<input type="text" id="roster-new-studentno" placeholder="學生編號" style="max-width:120px">' +
        '<input type="text" id="roster-new-class" placeholder="班別" style="max-width:90px">' +
        '<input type="text" id="roster-new-no" placeholder="學號" style="max-width:90px">' +
        '<input type="text" id="roster-new-name" placeholder="姓名" style="max-width:160px">' +
        '<select id="roster-new-gender" style="max-width:90px">' +
          '<option value="">性別</option><option value="男">男</option><option value="女">女</option>' +
        '</select>' +
        '<input type="date" id="roster-new-dob" aria-label="出生日期" style="max-width:160px">' +
        '<button class="btn btn-sm" type="submit">+ 新增學生</button>' +
      '</form>' +
      '<input type="file" id="roster-import-file-input" accept=".xlsx,.xls,.csv" hidden>' +
      '<input type="file" id="roster-sync-file-input" accept=".xlsx,.xls,.csv" hidden>' +
      (roster.length
        ? '<div class="table-wrap"><table class="data"><thead><tr><th>學生編號</th><th>班別</th><th>學號</th><th>姓名</th><th>性別</th><th>出生日期</th><th></th></tr></thead><tbody>' +
            pageRoster.map(rosterRowHTML).join('') + '</tbody></table></div>' +
          renderRosterPager(roster.length, totalPages)
        : '<div class="cell-muted">「' + esc(year) + '」尚未輸入學生名單。</div>') +
    '</div>'
  );
}

// 學生名單管理表格的分頁列：「上一頁／下一頁」按鈕 + 「第 X / Y 頁（共 N 位學生）」
// 文字。只有一頁時不顯示按鈕（沒有分頁的必要），但仍顯示總筆數文字。
function renderRosterPager(totalCount, totalPages){
  if (totalPages <= 1){
    return '<div class="hint" style="margin-top:2px">共 ' + totalCount + ' 位學生</div>';
  }
  return (
    '<div class="row" style="align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:2px">' +
      '<div class="hint" style="margin:0">第 ' + ui.rosterPage + ' / ' + totalPages + ' 頁（共 ' + totalCount + ' 位學生）</div>' +
      '<div class="row" style="gap:6px">' +
        '<button type="button" class="btn btn-sm btn-ghost" data-action="roster-prev-page"' + (ui.rosterPage <= 1 ? ' disabled' : '') + '>上一頁</button>' +
        '<button type="button" class="btn btn-sm btn-ghost" data-action="roster-next-page"' + (ui.rosterPage >= totalPages ? ' disabled' : '') + '>下一頁</button>' +
      '</div>' +
    '</div>'
  );
}

function renderStudentsView(){
  return (
    '<div class="stack">' +
      '<div class="card card-pad stack">' +
        '<div class="section-title">學生獲獎記錄查詢（跨學年）</div>' +
        '<input type="search" id="student-search" placeholder="輸入學生姓名或學生編號，查詢他／她在所有學年的獲獎記錄…" value="' + escAttr(ui.studentSearch) + '">' +
        '<div id="student-search-results">' + renderStudentSearchResults() + '</div>' +
      '</div>' +
      renderRosterSection() +
    '</div>'
  );
}

/* ============================================================
   Stats view (admin only)
   ============================================================ */

function renderBarList(entries){
  if (!entries.length) return '<div class="cell-muted">暫無資料</div>';
  var max = entries[0][1] || 1;
  return '<div class="bar-list">' + entries.map(function(pair){
    return (
      '<div class="bar-row">' +
        '<div class="bar-rank-label" title="' + escAttr(pair[0]) + '">' + esc(pair[0]) + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(4, (pair[1]/max*100)) + '%"></div></div>' +
        '<div class="bar-value">' + pair[1] + '</div>' +
      '</div>'
    );
  }).join('') + '</div>';
}

// Shared header for every stats card: a title plus a "匯出 CSV" button. The
// button carries which stat this card is (data-stat) so the click handler
// can recompute that exact ranking (full list, not the on-screen top-N) and
// export it on its own — see the 'export-stat' action.
function statSectionHead(title, statKey, truncated){
  var tip = truncated ? '匯出完整名單為 CSV（不限於畫面上顯示的排行數目）' : '匯出此項統計為 CSV';
  return (
    '<div class="row" style="align-items:center;justify-content:space-between;margin-bottom:2px">' +
      '<div class="section-title" style="margin-bottom:0">' + esc(title) + '</div>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-action="export-stat" data-stat="' + escAttr(statKey) + '" title="' + escAttr(tip) + '">匯出 CSV</button>' +
    '</div>'
  );
}

function renderStatsView(){
  var records = recordsForYear(ui.selectedYear);
  var stats = computeStats(records);
  var perStudentEntries = sortedEntries(
    Object.keys(stats.perStudent).reduce(function(acc,k){ acc[k]=stats.perStudent[k].count; return acc; },{}), 15
  ).map(function(pair){
    var s = stats.perStudent[pair[0]];
    return [s.name + '（' + s.cls + '）', pair[1]];
  });
  var perClassEntries = sortedEntries(stats.perClass, 15);
  var perSubjectRecipientEntries = sortedEntries(stats.perSubjectRecipients);
  var perSubjectAwardEntries = sortedEntries(stats.perSubjectAwards);
  var perTeacherEntries = sortedEntries(stats.perTeacher, 12);
  var reviewCount = records.filter(function(r){ return r.needsReview; }).length;
  var typeAwardEntries = [['個人', stats.perTypeAwards.individual], ['團體', stats.perTypeAwards.team], ['學校', stats.perTypeAwards.school], ['教師', stats.perTypeAwards.teacher]];
  var typeRecipientEntries = [['個人', stats.perTypeRecipients.individual], ['團體', stats.perTypeRecipients.team], ['學校', stats.perTypeRecipients.school], ['教師', stats.perTypeRecipients.teacher]];

  return (
    '<div class="stack">' +
      '<div class="grid-3">' +
        '<div class="card stat-card"><div class="stat-num">' + records.length + '</div><div class="stat-label">活動 / 比賽總數</div></div>' +
        '<div class="card stat-card"><div class="stat-num">' + totalAwardCount(records) + '</div><div class="stat-label">獎項總數</div></div>' +
        '<div class="card stat-card"><div class="stat-num">' + totalRecipientCount(records) + '</div><div class="stat-label">獲獎人次總數</div></div>' +
      '</div>' +

      '<div class="grid-2">' +
        '<div class="card card-pad">' +
          statSectionHead('個人／團體／學校／教師 獎項數', 'type-awards') +
          renderBarList(typeAwardEntries) +
        '</div>' +
        '<div class="card card-pad">' +
          statSectionHead('個人／團體／學校／教師 獲獎人次', 'type-recipients') +
          renderBarList(typeRecipientEntries) +
        '</div>' +
      '</div>' +

      '<div class="grid-2">' +
        '<div class="card card-pad">' +
          statSectionHead('學生獲獎排行（頭 15 位）', 'student-rank', true) +
          renderBarList(perStudentEntries) +
        '</div>' +
        '<div class="card card-pad">' +
          statSectionHead('班別獲獎人次（頭 15 班）', 'class-rank', true) +
          renderBarList(perClassEntries) +
        '</div>' +
      '</div>' +

      '<div class="grid-2">' +
        '<div class="card card-pad">' +
          statSectionHead('各科目獲獎人次', 'subject-recipients') +
          renderBarList(perSubjectRecipientEntries) +
        '</div>' +
        '<div class="card card-pad">' +
          statSectionHead('各科目獎項數量', 'subject-awards') +
          renderBarList(perSubjectAwardEntries) +
        '</div>' +
      '</div>' +

      '<div class="card card-pad">' +
        statSectionHead('老師負責活動數（頭 12 位）', 'teacher-activity', true) +
        renderBarList(perTeacherEntries) +
      '</div>' +

      (reviewCount ? '<div class="banner banner-warn">目前有 ' + reviewCount + ' 項記錄標記為「待確認」，前往「設定與匯出」查看清單。</div>' : '') +
    '</div>'
  );
}

/* ============================================================
   Club roster management card (part of Settings view, admin only)
   ============================================================ */

function clubRosterRowHTML(r){
  return (
    '<tr data-id="' + escAttr(r.id) + '">' +
      '<td>' + esc(r.club) + '</td>' +
      '<td>' + esc(r.class || '') + '</td>' +
      '<td>' + esc(r.no || '') + '</td>' +
      '<td>' + esc(r.name) + '</td>' +
      '<td class="cell-actions">' +
        (ui.clubRosterDeleteConfirmId === r.id
          ? '<button class="btn btn-sm btn-danger" type="button" data-action="confirm-remove-club" data-id="' + escAttr(r.id) + '">確定刪除</button>' +
            '<button class="btn btn-sm btn-ghost" type="button" data-action="cancel-remove-club">取消</button>'
          : '<button class="btn btn-sm btn-ghost btn-danger" type="button" data-action="ask-remove-club" data-id="' + escAttr(r.id) + '">刪除</button>') +
      '</td>' +
    '</tr>'
  );
}

// Split out from renderClubRosterSection so the search filter (see
// onClubRosterFilter) can re-render just the table body via its own
// #club-roster-table container, instead of a full settings-page render
// on every keystroke.
function renderClubRosterTableBody(){
  var year = ui.clubRosterYear || ui.selectedYear;
  var q = (ui.clubFilterQuery || '').trim().toLowerCase();
  var club = ui.clubRosterSelectedClub || '';

  // Mirrors the "按教師"/"按學生" gating pattern used in the main 獲獎記錄 list
  // (see matchesStructuralFilters / renderListResults): a school can have
  // hundreds of club members across dozens of activities, so this table only
  // shows rows once the admin has narrowed it down — either by picking one
  // activity from the dropdown, or by typing a search — rather than dumping
  // everyone in the school year onto the screen at once.
  if (!club && !q){
    if (!clubRosterForYear(year).length){
      return '<div class="cell-muted" style="padding:10px 0">此學年尚未有課外活動名單資料。</div>';
    }
    return '<div class="cell-muted" style="padding:10px 0">請先在上方選擇課外活動，或直接搜尋活動／班別／姓名，才會顯示名單。</div>';
  }

  var roster = clubRosterForYear(year).slice().sort(function(a,b){
    return a.club.localeCompare(b.club, 'zh-Hant') || (a.class||'').localeCompare(b.class||'') ||
      String(a.no||'').localeCompare(String(b.no||''), undefined, {numeric:true}) || a.name.localeCompare(b.name, 'zh-Hant');
  });
  if (club){
    roster = roster.filter(function(r){ return r.club === club; });
  }
  if (q){
    roster = roster.filter(function(r){
      return r.club.toLowerCase().indexOf(q) !== -1 || r.name.toLowerCase().indexOf(q) !== -1 ||
        (r.class||'').toLowerCase().indexOf(q) !== -1;
    });
  }
  if (!roster.length){
    return '<div class="cell-muted" style="padding:10px 0">沒有符合的成員。</div>';
  }
  return '<div class="table-wrap"><table class="data"><thead><tr><th>課外活動</th><th>班別</th><th>學號</th><th>姓名</th><th></th></tr></thead><tbody>' +
    roster.map(clubRosterRowHTML).join('') + '</tbody></table></div>';
}

function renderClubRosterSection(){
  var year = ui.clubRosterYear || ui.selectedYear;
  var yearOptions = STATE.schoolYears.map(function(y){
    return '<option value="' + escAttr(y) + '"' + (y===year?' selected':'') + '>' + esc(y) + '</option>';
  }).join('');
  var totalCount = clubRosterForYear(year).length;
  var clubNames = clubNamesForYear(year);
  var clubCount = clubNames.length;
  var clubFilterOptions = '<option value="">請選擇課外活動</option>' + clubNames.map(function(c){
    return '<option value="' + escAttr(c) + '"' + (c === ui.clubRosterSelectedClub ? ' selected' : '') + '>' + esc(c) + '</option>';
  }).join('');
  return (
    '<div class="card card-pad stack">' +
      '<div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap">' +
        '<div class="section-title" style="margin:0">課外活動名單（' + clubCount + ' 個活動，共 ' + totalCount + ' 筆）</div>' +
        '<div class="row wrap" style="align-items:center">' +
          '<select id="club-roster-year-select">' + yearOptions + '</select>' +
          '<button type="button" class="btn btn-sm" data-action="open-club-import">匯入名單</button>' +
          hintIcon('匯入的 Excel／CSV 需包含「學會名稱」（或「活動名稱」）、「班別」「學號」「姓名」欄，第一行為標題（可先下載範本參考格式，也直接支援學校課外活動系統匯出的名單格式，其餘欄位會自動忽略）。匯入會把檔案當成<b>檔案內出現的那些活動</b>的最新名單：新增名單中未有的成員，並移除這些活動目前名單中、但不在檔案內的成員（視為已退出）；<b>沒有出現在檔案裡的其他活動完全不受影響</b>，套用前會先顯示預覽讓你確認。建立好的名單可在「新增記錄」表單的「從課外活動名單選取」使用，一次勾選整個活動的多位學生加入得獎人，不用逐一手動輸入班別/學號/姓名。') +
          '<button type="button" class="btn btn-sm" data-action="download-club-template">下載範本</button>' +
        '</div>' +
      '</div>' +
      '<form class="row wrap" id="add-club-form">' +
        '<input type="text" id="club-new-name" placeholder="課外活動名稱" style="max-width:180px">' +
        '<input type="text" id="club-new-class" placeholder="班別" style="max-width:90px">' +
        '<input type="text" id="club-new-no" placeholder="學號" style="max-width:90px">' +
        '<input type="text" id="club-new-studentname" placeholder="姓名" style="max-width:160px">' +
        '<button class="btn btn-sm" type="submit">+ 新增成員</button>' +
      '</form>' +
      '<input type="file" id="club-import-file-input" accept=".xlsx,.xls,.csv" hidden>' +
      '<div class="row wrap" style="align-items:center">' +
        '<select id="club-roster-club-select" style="max-width:200px">' + clubFilterOptions + '</select>' +
        '<input type="search" id="club-roster-filter" placeholder="搜尋活動／班別／姓名" value="' + escAttr(ui.clubFilterQuery || '') + '" style="max-width:220px">' +
      '</div>' +
      '<div id="club-roster-table">' + renderClubRosterTableBody() + '</div>' +
    '</div>'
  );
}

/* ============================================================
   資料品質檢查卡片（2026-09-20 新增，2026-09-21 改為只掃描目前選定學年，
   見上方「資料品質檢查」一節的三個 scan 函式）——設定頁裡的內建資料品質
   工具，涵蓋待確認記錄、負責老師合併掃描、比賽日期格式異常、得獎人姓名
   可疑四項檢查，四項都只看 ui.selectedYear（設定頁頂端「學年」下拉選單
   目前選到的那個學年）這一個學年的記錄，切換學年後（year-select 觸發
   render()）這裡也會跟著重新計算、只顯示該學年的異常記錄。
   ============================================================ */

function renderDataQualitySection(){
  var year = ui.selectedYear;
  var reviewRecs = recordsForYear(year).filter(function(r){ return r.needsReview; });
  var teacherFixes = scanTeacherMerges(year);
  var dateIssues = scanDateFormats(year);
  var dateFixable = dateIssues.filter(function(d){ return d.suggested; });
  var nameIssues = scanSuspiciousRecipientNames(year);

  var reviewHtml = reviewRecs.length
    ? reviewRecs.map(function(r){
        return '<div class="review-item">' +
          '<div>' +
            '<div><b>' + esc(r.subject) + '</b> · ' + esc(r.event) + ' <span class="badge badge-muted">' + esc(r.schoolYear) + '</span></div>' +
            (r.reviewNote ? '<div class="rn">' + esc(r.reviewNote) + '</div>' : '') +
          '</div>' +
          '<div class="row" style="flex:0 0 auto">' +
            '<button class="btn btn-sm" type="button" data-action="edit-record" data-id="' + escAttr(r.id) + '">前往編輯</button>' +
            '<button class="btn btn-sm btn-ghost" type="button" data-action="clear-review" data-id="' + escAttr(r.id) + '">標記已確認</button>' +
          '</div>' +
        '</div>';
      }).join('')
    : '<div class="cell-muted">目前沒有待確認的記錄。</div>';

  var teacherFixHtml = teacherFixes.length
    ? teacherFixes.map(function(f){
        return '<div class="review-item">' +
          '<div style="flex:1 1 auto">' +
            '<label class="check-inline">' +
              '<input type="checkbox" class="dq-teacher-check" data-id="' + escAttr(f.id) + '" checked>' +
              '<b>' + esc(f.event) + '</b>' +
            '</label>' +
            ' <span class="badge badge-muted">' + esc(f.schoolYear) + '</span>' +
            '<div class="dq-line">原始：' + esc(f.original.replace(/\n/g, '／')) + '</div>' +
            '<div class="dq-line dq-suggest">建議：' + esc(f.suggested.replace(/\n/g, '、')) + '</div>' +
          '</div>' +
        '</div>';
      }).join('')
    : '<div class="cell-muted">目前沒有偵測到可疑的合併記錄。</div>';

  var dateFixHtml = dateIssues.length
    ? dateIssues.map(function(d){
        return '<div class="review-item">' +
          '<div style="flex:1 1 auto">' +
            (d.suggested
              ? '<label class="check-inline"><input type="checkbox" class="dq-date-check" data-id="' + escAttr(d.id) + '" checked> <b>' + esc(d.event) + '</b></label>'
              : '<b>' + esc(d.event) + '</b>') +
            ' <span class="badge badge-muted">' + esc(d.schoolYear) + '</span>' +
            '<div class="dq-line">原始：' + esc(d.original) +
              (d.suggested ? '　建議：<span class="dq-suggest">' + esc(d.suggested) + '</span>' : '　（格式無法自動判斷，需人工確認）') +
            '</div>' +
          '</div>' +
          '<div class="row" style="flex:0 0 auto">' +
            '<button class="btn btn-sm btn-ghost" type="button" data-action="edit-record" data-id="' + escAttr(d.id) + '">前往編輯</button>' +
          '</div>' +
        '</div>';
      }).join('')
    : '<div class="cell-muted">目前沒有偵測到格式異常的比賽日期。</div>';

  var nameIssueHtml = nameIssues.length
    ? nameIssues.map(function(n){
        return '<div class="review-item">' +
          '<div>' +
            '<div><b>' + esc(n.event) + '</b> <span class="badge badge-muted">' + esc(n.schoolYear) + '</span> · ' + esc(n.awardName) + '</div>' +
            '<div class="dq-line">「' + esc(n.name) + '」 <span class="badge badge-warn">' + esc(n.reason) + '</span></div>' +
          '</div>' +
          '<div class="row" style="flex:0 0 auto">' +
            '<button class="btn btn-sm btn-ghost" type="button" data-action="edit-record" data-id="' + escAttr(n.id) + '">前往編輯</button>' +
          '</div>' +
        '</div>';
      }).join('')
    : '<div class="cell-muted">目前沒有偵測到可疑的得獎人姓名。</div>';

  return (
    '<div class="card card-pad stack">' +
      '<div class="section-title">資料品質檢查（' + esc(year) + '）' + hintIcon('自動掃描「' + year + '」這個學年的記錄，列出幾類常見的資料問題，方便定期檢視，不用每次都手動逐筆檢查、也不用回來對話裡請人掃描；只看目前設定頁頂端選定的學年，切換學年選單就會換成掃描該學年。「負責老師合併成一行」與「比賽日期格式異常」若能安全判斷出正確答案，會附上建議修正，勾選要套用的項目後按「套用勾選的建議修正」即可批次寫入；其餘（待確認記錄、得獎人姓名可疑）需要人工判斷正確答案，系統不猜測，只列出清單並附「前往編輯」按鈕方便直接跳過去手動修正。') + '</div>' +

      '<div class="stack" style="gap:10px">' +
        '<div class="section-title" style="margin:0">待確認記錄（' + reviewRecs.length + '）</div>' +
        reviewHtml +
      '</div>' +

      '<div class="stack" style="gap:10px">' +
        '<div class="section-title" style="margin:0">負責老師合併成一行（' + teacherFixes.length + '）</div>' +
        teacherFixHtml +
        (teacherFixes.length ? '<div class="row"><button class="btn btn-sm btn-primary" type="button" data-action="apply-teacher-fixes">套用勾選的建議修正</button></div>' : '') +
      '</div>' +

      '<div class="stack" style="gap:10px">' +
        '<div class="section-title" style="margin:0">比賽日期格式異常（' + dateIssues.length + '）</div>' +
        dateFixHtml +
        (dateFixable.length ? '<div class="row"><button class="btn btn-sm btn-primary" type="button" data-action="apply-date-fixes">套用勾選的建議修正</button></div>' : '') +
      '</div>' +

      '<div class="stack" style="gap:10px">' +
        '<div class="section-title" style="margin:0">得獎人姓名可疑（' + nameIssues.length + '）</div>' +
        nameIssueHtml +
      '</div>' +

    '</div>'
  );
}

/* ============================================================
   Settings view (admin only)
   ============================================================ */

function renderSettingsView(){
  // Subject order here is STATE.subjects' own array order — it's the single
  // canonical order used everywhere else too (list-view 按科目 grouping,
  // the add/edit form's subject dropdown, the list filter dropdown), so
  // reordering it here reorders it everywhere without extra plumbing.
  var subjectRowsHtml = STATE.subjects.map(function(s, i){
    return '<div class="row" style="align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--color-border)">' +
      '<span style="flex:1 1 auto">' + esc(s) + '</span>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-action="move-subject-up" data-subject="' + escAttr(s) + '" title="上移"' + (i===0?' disabled':'') + '>↑</button>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-action="move-subject-down" data-subject="' + escAttr(s) + '" title="下移"' + (i===STATE.subjects.length-1?' disabled':'') + '>↓</button>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-action="rename-subject" data-subject="' + escAttr(s) + '" title="重新命名科目">重新命名</button>' +
      '<button type="button" class="btn btn-sm btn-ghost btn-danger" data-action="remove-subject" data-subject="' + escAttr(s) + '" title="移除科目">移除</button>' +
    '</div>';
  }).join('');

  var teacherChips = STATE.teachers.map(function(t){
    return '<span class="chip">' + esc(t) +
      '<button type="button" data-action="remove-teacher" data-teacher="' + escAttr(t) + '" title="移除教師">✕</button></span>';
  }).join('') || '<div class="cell-muted">尚未新增任何教師。</div>';

  var yearChips = STATE.schoolYears.map(function(y){
    var isCurrent = y === STATE.meta.currentSchoolYear;
    return '<span class="chip' + (isCurrent?' is-current':'') + '">' + esc(y) + (isCurrent ? '（目前）' : '') +
      (isCurrent ? '' : ' <button type="button" data-action="set-current-year" data-year="' + escAttr(y) + '" title="設為目前學年" style="width:auto;border-radius:4px;padding:2px 6px;font-size:11px;color:var(--color-accent)">設為目前</button>') +
      '<button type="button" data-action="remove-year" data-year="' + escAttr(y) + '" title="移除學年">✕</button></span>';
  }).join('');

  return (
    '<div class="stack">' +

      '<div class="card card-pad stack">' +
        '<div class="section-title">學年管理' + hintIcon('新增記錄時預設使用「目前」學年；仍有記錄使用中的學年無法移除。') + '</div>' +
        '<div class="chip-row">' + yearChips + '</div>' +
        '<form class="row" id="add-year-form">' +
          '<input type="text" id="new-year-name" placeholder="新增學年，例如：2026-2027" style="max-width:260px">' +
          '<button class="btn btn-sm" type="submit">新增學年</button>' +
        '</form>' +
      '</div>' +

      '<div class="card card-pad stack">' +
        '<div class="section-title">科目分類' + hintIcon('用 ↑↓ 調整科目排序，記錄總覽的「按科目」分組、新增記錄的科目選單都會跟隨此順序。「重新命名」會同步更新所有使用這個科目的既有記錄（若改成的名稱剛好是另一個已存在的科目，會直接合併過去）；「移除」仍在使用中的科目前會先提示影響範圍，移除後只是把它從新增/編輯記錄的選單中拿掉，不會更改任何既有記錄。') + '</div>' +
        '<div>' + subjectRowsHtml + '</div>' +
        '<form class="row" id="add-subject-form">' +
          '<input type="text" id="new-subject-name" placeholder="新增科目名稱，例如：圖書科" style="max-width:260px">' +
          '<button class="btn btn-sm" type="submit">新增科目</button>' +
        '</form>' +
      '</div>' +

      '<div class="card card-pad stack">' +
        '<div class="section-title">教師名單' + hintIcon('用於新增/編輯記錄時「負責老師」的下拉式選單；名單以外的老師仍可在表單的「其他老師」欄位輸入。匯入 Excel/CSV 時會辨識標題含「姓名」的欄位，逐行讀取姓名加入名單（已存在的姓名會自動略過，不會重複）。移除某位教師只會把他從這份下拉名單拿掉，不會更改任何既有記錄的負責老師欄位；若該教師仍有記錄使用中，移除前會先彈出確認提示。') + '</div>' +
        '<div class="chip-row">' + teacherChips + '</div>' +
        '<form class="row" id="add-teacher-form">' +
          '<input type="text" id="new-teacher-name" placeholder="新增教師姓名" style="max-width:260px">' +
          '<button class="btn btn-sm" type="submit">新增教師</button>' +
        '</form>' +
        '<div class="row">' +
          '<button type="button" class="btn btn-sm" data-action="open-teacher-import">匯入 Excel</button>' +
          '<button type="button" class="btn btn-sm" data-action="download-teacher-template">下載範本</button>' +
        '</div>' +
        '<input type="file" id="teacher-import-file-input" accept=".xlsx,.xls,.csv" hidden>' +
      '</div>' +

      renderClubRosterSection() +

      renderDataQualitySection() +

      '<div class="card card-pad stack">' +
        '<div class="section-title">匯出資料</div>' +
        '<div class="hint">匯出成 CSV 檔案（每個獎項的每位得獎學生一行）——雙擊或用 Excel 開啟／匯入即為 Excel 試算表；此頁面所在平台的下載功能不支援直接產生 .xlsx 檔案，CSV 已可完整對應 Excel 需要的欄位與內容。匯出目前選定學年（' + esc(ui.selectedYear) + '）的資料。</div>' +
        '<div class="row"><button class="btn btn-primary" type="button" data-action="export-csv">匯出 CSV（Excel 適用）</button></div>' +
      '</div>' +

      '<div class="card card-pad stack">' +
        '<div class="section-title">清除年度資料</div>' +
        '<div class="hint">系統會一直累積每個學年的獲獎記錄及學生名單，年份一多可能令載入及搜尋變慢。' +
          '這裡可以永久刪除某個學年的全部獲獎記錄及學生名單，騰出空間——' +
          '<b>此操作無法復原，建議先在上方「匯出資料」備份該學年再清除</b>。無法清除目前使用中的學年，' +
          '請先在「學年管理」把其他學年設為目前學年。</div>' +
        '<div class="row" style="align-items:center;gap:10px">' +
          '<select id="clear-year-select" style="max-width:220px">' +
            STATE.schoolYears.map(function(y){
              var isCurrent = y === STATE.meta.currentSchoolYear;
              return '<option value="' + escAttr(y) + '"' + (isCurrent?' disabled':'') + '>' + esc(y) + (isCurrent ? '（目前，無法清除）' : '') + '</option>';
            }).join('') +
          '</select>' +
          '<button class="btn btn-danger" type="button" data-action="ask-clear-year">清除此學年資料</button>' +
        '</div>' +
      '</div>' +

    '</div>'
  );
}

/* ============================================================
   CSV export / template download
   (The published-page "downloads" capability only offers a fixed set of
   file extensions, and .xlsx is not among them, so every file this page
   offers — exports and import templates alike — is a .csv file. CSV
   opens directly in Excel, so this is functionally the "Excel" version
   for anyone opening it there; there is no separate binary .xlsx file.)
   ============================================================ */

function rowsToCSV(rows){
  return '﻿' + rows.map(function(row){ return row.map(csvEscape).join(','); }).join('\r\n');
}

// 2026-09-21 GitHub + Firebase 版本：不再跑在 Claude Artifact 環境裡，沒有
// window.claude.use('downloads') 這個能力，改用一般網頁最標準的下載做法——
// 把內容包成 Blob、建立一個隱藏的 <a download> 連結、模擬點擊觸發瀏覽器下載，
// 是每個瀏覽器都支援、不需要任何額外套件的寫法。
function downloadCSV(filename, rows, successMsg){
  try{
    var csv = rowsToCSV(rows);
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    showToast(successMsg || '已下載');
  }catch(err){
    showToast('下載失敗：' + (err && err.message ? err.message : '未知錯誤'));
  }
}

function exportCSV(){
  // 比賽編號（rec.seq）／獎項編號（a.seq）：見上方 backfillSeqNumbers 的說明——同一個
  // 獎項編號會在多個收件人（recipients）列中重複出現，方便在 Excel 用篩選或排序功能
  // 一眼看出哪幾行其實是同一個獎項（例如一個團體獎有多位得獎學生）；比賽編號則能把
  // 同一場比賽底下所有獎項/學生行群組起來。兩者都是穩定不變的整數，取代舊版只有內部
  // 用途、對人不友善的活動編號（rec.id）欄位。
  var header = ['學年','科目','比賽編號','活動/比賽名稱','主辦機構','比賽日期','獎項編號','項目','獎項名稱','獎項類型','班別','學號','學生姓名','負責老師','校務處理備註','學段/優點備註','待確認'];
  var rows = [header];
  recordsForYear(ui.selectedYear).forEach(function(rec){
    (rec.awards||[]).forEach(function(a){
      (a.recipients||[]).forEach(function(rp){
        rows.push([
          rec.schoolYear, rec.subject, formatRecordSeq(rec.seq), rec.event, rec.organizer,
          rec.date, formatAwardSeq(a.seq, rec.seq), a.item || '', a.name, (a.type === 'team' ? '團體' : (a.type === 'school' ? '學校' : (a.type === 'teacher' ? '教師' : '個人'))), rp.class, rp.no || '', rp.name, rec.teacher,
          rec.admin1 || '', rec.admin2 || '', rec.needsReview ? '是' : ''
        ]);
      });
    });
  });
  var filename = (STATE.meta.schoolName || '學生獲獎紀錄') + '_' + ui.selectedYear + '_匯出_' + todayISO() + '.csv';
  downloadCSV(filename, rows, '已匯出 CSV（可用 Excel 開啟）');
}

// Each 統計排行 card can be exported on its own (回應使用者要求：每項統計要有獨立匯出功能）。
// Recomputed fresh from the currently selected year rather than reusing
// whatever renderStatsView last built, and deliberately UNTRUNCATED — the
// on-screen bar lists cap at the top 12/15 for readability, but an export
// is presumably for record-keeping, so it always contains the full ranking
// regardless of what "頭 N 位" the card's title says on screen.
function exportStatByKey(statKey){
  var records = recordsForYear(ui.selectedYear);
  var stats = computeStats(records);
  var yearLabel = ui.selectedYear || STATE.meta.currentSchoolYear || '全部';
  var defs = {
    'type-awards': {
      label: '個人團體學校教師獎項數', header: ['類型', '獎項數'],
      entries: [['個人', stats.perTypeAwards.individual], ['團體', stats.perTypeAwards.team], ['學校', stats.perTypeAwards.school], ['教師', stats.perTypeAwards.teacher]]
    },
    'type-recipients': {
      label: '個人團體學校教師獲獎人次', header: ['類型', '獲獎人次'],
      entries: [['個人', stats.perTypeRecipients.individual], ['團體', stats.perTypeRecipients.team], ['學校', stats.perTypeRecipients.school], ['教師', stats.perTypeRecipients.teacher]]
    },
    'student-rank': {
      label: '學生獲獎排行', header: ['學生', '班別', '獲獎人次'],
      entries: sortedEntries(Object.keys(stats.perStudent).reduce(function(acc,k){ acc[k] = stats.perStudent[k].count; return acc; }, {}))
        .map(function(pair){ var s = stats.perStudent[pair[0]]; return [s.name, s.cls, pair[1]]; })
    },
    'class-rank': {
      label: '班別獲獎人次', header: ['班別', '獲獎人次'],
      entries: sortedEntries(stats.perClass)
    },
    'subject-recipients': {
      label: '各科目獲獎人次', header: ['科目', '獲獎人次'],
      entries: sortedEntries(stats.perSubjectRecipients)
    },
    'subject-awards': {
      label: '各科目獎項數量', header: ['科目', '獎項數'],
      entries: sortedEntries(stats.perSubjectAwards)
    },
    'teacher-activity': {
      label: '老師負責活動數', header: ['老師', '活動數'],
      entries: sortedEntries(stats.perTeacher)
    }
  };
  var def = defs[statKey];
  if (!def) return;
  var rows = [def.header].concat(def.entries.map(function(row){ return row; }));
  var filename = (STATE.meta.schoolName || '學生獲獎紀錄') + '_' + yearLabel + '_' + def.label + '_' + todayISO() + '.csv';
  downloadCSV(filename, rows, '已匯出「' + def.label + '」CSV');
}

function downloadAwardImportTemplate(){
  var rows = [
    ['項目', '獎項', '類型', '班別', '學號', '姓名'],
    ['例：100米賽跑（男子組）', '冠軍', '個人', '5A', '12', '陳小明'],
    ['', '亞軍', '個人', '5A', '18', '李小華'],
    ['例：接力賽（男子組）', '亞軍', '團體', '6B', '3', '黃小芳'],
    ['', '', '', '6B', '9', '林大文'],
    ['', '優異獎', '個人', '6A', '5', '王小美'],
    ['', '最佳指導老師獎', '教師', '', '', '陳志紅老師'],
    ['', '積極參與獎', '學校', '', '', STATE.meta.schoolName || '樂華天主教小學']
  ];
  downloadCSV('獎項匯入範本.csv', rows, '已下載範本（可用 Excel 開啟）');
}

function downloadRosterImportTemplate(){
  var rows = [
    ['學生編號', '班別', '學號', '姓名', '性別', '出生日期'],
    ['S00123', '5A', '1', '陳小明', '男', '2015-03-12'],
    ['S00124', '5A', '2', '李小華', '女', '2015-07-30']
  ];
  downloadCSV('學生名單匯入範本.csv', rows, '已下載範本（可用 Excel 開啟）');
}

/* ============================================================
   Event delegation
   ============================================================ */

root.addEventListener('click', function(e){
  // Close any open dropdown panel (負責老師, 從學生名單選取, 從課外活動名單
  // 選取, …) on a click outside it — its own toggle button included, that
  // click is handled by the action branch below. querySelectorAll (not
  // querySelector) because more than one of these .ms-dropdown panels can
  // exist on the page/form at once; each is closed independently so that
  // opening one always closes any other that's currently open, and a click
  // on a second panel's toggle button correctly closes the first.
  var openPanels = root.querySelectorAll('.ms-panel:not([hidden])');
  openPanels.forEach(function(openPanel){
    var openWrap = openPanel.closest('.ms-dropdown');
    if (openWrap && !openWrap.contains(e.target)){
      openPanel.setAttribute('hidden', '');
      openWrap.classList.remove('open');
    }
  });

  // Same idea for open 說明 popovers (see hintIcon()): close any that are
  // open when the click lands outside their own .hint-wrap (their own
  // toggle button included — that click is handled by the 'toggle-hint'
  // action branch below, which decides whether this counts as opening a
  // *different* one or re-closing the same one).
  var openHints = root.querySelectorAll('.hint-panel:not([hidden])');
  openHints.forEach(function(openHint){
    var hintWrap = openHint.closest('.hint-wrap');
    if (hintWrap && !hintWrap.contains(e.target)){
      openHint.setAttribute('hidden', '');
      var hintBtn = hintWrap.querySelector('.hint-icon');
      if (hintBtn) hintBtn.setAttribute('aria-expanded', 'false');
    }
  });

  var backdrop = e.target.closest('[data-action="modal-backdrop"]');
  if (backdrop && e.target === backdrop){
    ui.modal = null;
    renderModal();
    return;
  }

  var btn = e.target.closest('[data-action]');
  if (!btn) return;
  var action = btn.dataset.action;

  if (action === 'toggle-hint'){
    // The generic outside-click block above already closed every *other*
    // open .hint-panel (including one belonging to a different hint icon);
    // here we only need to flip this one icon's own panel, since a second
    // click on the same icon while its panel is open should close it
    // again rather than leaving it stuck open.
    var hintWrap2 = btn.closest('.hint-wrap');
    var hintPanel = hintWrap2.querySelector('.hint-panel');
    var hintWasHidden = hintPanel.hasAttribute('hidden');
    if (hintWasHidden){
      hintPanel.removeAttribute('hidden');
      btn.setAttribute('aria-expanded', 'true');
      // Left-anchored (the CSS default, left:0 relative to .hint-wrap) runs
      // the panel off the right edge of the viewport when the icon itself
      // sits close to that edge (e.g. the award-block "項目/類型" hint,
      // right next to that block's own 刪除獎項 button); simply flipping to
      // a right-anchor in that case can just as easily run it off the
      // *left* edge instead on a narrow phone screen, where the panel's
      // own width is a large fraction of the viewport. So instead of a
      // fixed left/right choice, clamp the panel's actual position (as a
      // 'left' offset in px, measured from .hint-wrap like the CSS default
      // already is) so it always stays fully within the viewport with a
      // small margin, regardless of where its icon happens to sit or how
      // narrow the screen is.
      var wrapRect = hintWrap2.getBoundingClientRect();
      var panelW = Math.min(320, window.innerWidth * 0.8);
      var margin = 10;
      var desiredLeft = wrapRect.left; // viewport-relative, same as the CSS default (offset 0)
      var maxLeft = window.innerWidth - margin - panelW;
      if (desiredLeft > maxLeft) desiredLeft = maxLeft;
      if (desiredLeft < margin) desiredLeft = margin;
      hintPanel.style.left = (desiredLeft - wrapRect.left) + 'px';
    } else {
      hintPanel.setAttribute('hidden', '');
      btn.setAttribute('aria-expanded', 'false');
      hintPanel.style.left = '';
    }
    return;
  }
  if (action === 'toggle-teacher-dropdown'){
    var teacherWrap = btn.closest('.ms-dropdown');
    var teacherPanel = teacherWrap.querySelector('.ms-panel');
    var wasHidden = teacherPanel.hasAttribute('hidden');
    if (wasHidden){
      teacherPanel.removeAttribute('hidden');
      teacherWrap.classList.add('open');
      var teacherSearch = teacherPanel.querySelector('.ms-search');
      if (teacherSearch) teacherSearch.focus();
    } else {
      teacherPanel.setAttribute('hidden', '');
      teacherWrap.classList.remove('open');
    }
    return;
  }
  if (action === 'toggle-roster-picker'){
    var rpWrap = btn.closest('.ms-dropdown');
    var rpPanel = rpWrap.querySelector('.ms-panel');
    var rpWasHidden = rpPanel.hasAttribute('hidden');
    if (rpWasHidden){
      rpPanel.removeAttribute('hidden');
      rpWrap.classList.add('open');
      populateRosterPickerClasses(rpWrap);
    } else {
      rpPanel.setAttribute('hidden', '');
      rpWrap.classList.remove('open');
    }
    return;
  }
  if (action === 'toggle-club-picker'){
    var cpWrap = btn.closest('.ms-dropdown');
    var cpPanel = cpWrap.querySelector('.ms-panel');
    var cpWasHidden = cpPanel.hasAttribute('hidden');
    if (cpWasHidden){
      cpPanel.removeAttribute('hidden');
      cpWrap.classList.add('open');
      populateClubPickerClubs(cpWrap);
    } else {
      cpPanel.setAttribute('hidden', '');
      cpWrap.classList.remove('open');
    }
    return;
  }

  if (action === 'nav'){
    var view = btn.dataset.view;
    ui.editingId = null;
    if (GATED_VIEWS[view] && !ui.adminMode){ requireAdmin(view); return; }
    setView(view);
    render();
    return;
  }
  if (action === 'open-login'){
    ui.modal = { type:'login', nextView: ui.view };
    renderModal();
    return;
  }
  if (action === 'close-modal'){
    ui.modal = null;
    renderModal();
    return;
  }
  if (action === 'admin-logout'){
    adminLogout();
    return;
  }
  if (action === 'google-logout'){
    // 登出 Google 帳號（不是上面的管理員密碼登出）——登出後會被
    // fbApi.onAuthChange() 導回登入畫面，STATE 也會清空。
    if (window.fbApi) window.fbApi.signOut();
    return;
  }
  if (action === 'add-award-block'){
    document.getElementById('awards-editor').insertAdjacentHTML('beforeend', awardBlockHTML());
    return;
  }
  if (action === 'remove-award-block'){
    btn.closest('.award-block').remove();
    return;
  }
  if (action === 'add-recipient-row'){
    var addBlock = btn.closest('.award-block');
    var list = addBlock.querySelector('.recipients-list');
    var addTypeSelect = addBlock.querySelector('.award-type');
    var isTeacherAdd = !!(addTypeSelect && addTypeSelect.value === 'teacher');
    list.insertAdjacentHTML('beforeend', recipientRowHTML(null, isTeacherAdd));
    return;
  }
  if (action === 'remove-recipient-row'){
    var row = btn.closest('.recipient-row');
    var list2 = btn.closest('.award-block').querySelector('.recipients-list');
    if (list2.children.length > 1) row.remove();
    else { row.querySelectorAll('input').forEach(function(i){ i.value=''; }); }
    return;
  }
  if (action === 'roster-picker-toggle-all'){
    var saWrap = btn.closest('.ms-dropdown');
    var boxes = saWrap.querySelectorAll('.roster-picker-student:not(:disabled)');
    var allChecked = boxes.length > 0 && Array.prototype.slice.call(boxes).every(function(cb){ return cb.checked; });
    boxes.forEach(function(cb){ cb.checked = !allChecked; });
    updateRosterPickerCount(saWrap);
    return;
  }
  if (action === 'roster-picker-add'){
    var addWrap = btn.closest('.ms-dropdown');
    var awardBlockEl = btn.closest('.award-block');
    var recipientsList = awardBlockEl.querySelector('.recipients-list');
    var checkedBoxes = Array.prototype.slice.call(addWrap.querySelectorAll('.roster-picker-student:checked'));
    if (!checkedBoxes.length) return;
    // 若目前清單只有一列、而且三個欄位都還空白（表單一開始就有的預設空白列），先移除它，
    // 免得選完學生後前面留一列多餘的空白得獎人列。
    var existingRows = Array.prototype.slice.call(recipientsList.querySelectorAll('.recipient-row'));
    if (existingRows.length === 1){
      var onlyRow = existingRows[0];
      var c0 = onlyRow.querySelector('.rec-class'), n0 = onlyRow.querySelector('.rec-no'), m0 = onlyRow.querySelector('.rec-name');
      var blank = (!c0 || !c0.value.trim()) && (!n0 || !n0.value.trim()) && (!m0 || !m0.value.trim());
      if (blank) recipientsList.innerHTML = '';
    }
    var addedHtml = checkedBoxes.map(function(cb){
      return recipientRowHTML({ class: cb.dataset.class, no: cb.dataset.no, name: cb.dataset.name }, false);
    }).join('');
    recipientsList.insertAdjacentHTML('beforeend', addedHtml);
    // 面板保持開啟，重新畫一次目前班別的名單，讓剛加入的學生變成「（已加入）」停用狀態、
    // 已勾選的重設成 0——方便老師接著選同班別或切換班別繼續加人，不用每次都重新展開面板。
    var classSel2 = addWrap.querySelector('.roster-picker-class');
    if (classSel2 && classSel2.value) renderRosterPickerStudentList(addWrap, classSel2.value);
    return;
  }
  if (action === 'club-picker-toggle-all'){
    var caWrap = btn.closest('.ms-dropdown');
    var cboxes = caWrap.querySelectorAll('.club-picker-student:not(:disabled)');
    var callChecked = cboxes.length > 0 && Array.prototype.slice.call(cboxes).every(function(cb){ return cb.checked; });
    cboxes.forEach(function(cb){ cb.checked = !callChecked; });
    updateClubPickerCount(caWrap);
    return;
  }
  if (action === 'club-picker-add'){
    var cAddWrap = btn.closest('.ms-dropdown');
    var cAwardBlockEl = btn.closest('.award-block');
    var cRecipientsList = cAwardBlockEl.querySelector('.recipients-list');
    var cCheckedBoxes = Array.prototype.slice.call(cAddWrap.querySelectorAll('.club-picker-student:checked'));
    if (!cCheckedBoxes.length) return;
    var cExistingRows = Array.prototype.slice.call(cRecipientsList.querySelectorAll('.recipient-row'));
    if (cExistingRows.length === 1){
      var cOnlyRow = cExistingRows[0];
      var cc0 = cOnlyRow.querySelector('.rec-class'), cn0 = cOnlyRow.querySelector('.rec-no'), cm0 = cOnlyRow.querySelector('.rec-name');
      var cBlank = (!cc0 || !cc0.value.trim()) && (!cn0 || !cn0.value.trim()) && (!cm0 || !cm0.value.trim());
      if (cBlank) cRecipientsList.innerHTML = '';
    }
    var cAddedHtml = cCheckedBoxes.map(function(cb){
      return recipientRowHTML({ class: cb.dataset.class, no: cb.dataset.no, name: cb.dataset.name }, false);
    }).join('');
    cRecipientsList.insertAdjacentHTML('beforeend', cAddedHtml);
    var clubSel2 = cAddWrap.querySelector('.club-picker-club');
    if (clubSel2 && clubSel2.value) renderClubPickerMemberList(cAddWrap, clubSel2.value);
    return;
  }
  if (action === 'open-import'){
    document.getElementById('import-file-input').click();
    return;
  }
  if (action === 'download-award-template'){
    downloadAwardImportTemplate();
    return;
  }
  if (action === 'confirm-import'){
    if (ui.modal && ui.modal.type === 'import'){
      applyImportGroups(ui.modal.groups);
      showToast('已匯入 ' + ui.modal.groups.length + ' 個獎項，請檢查後再儲存');
    }
    ui.modal = null;
    renderModal();
    return;
  }
  if (action === 'edit-record'){
    ui.editingId = btn.dataset.id;
    setView('add');
    render();
    window.scrollTo({top:0, behavior:'instant'});
    return;
  }
  if (action === 'cancel-edit'){
    ui.editingId = null;
    setView('list');
    render();
    return;
  }
  if (action === 'toggle-expand'){
    var id = btn.closest('tr').dataset.id;
    ui.expandedId = (ui.expandedId === id) ? null : id;
    document.getElementById('list-results').innerHTML = renderListResults();
    return;
  }
  if (action === 'ask-delete'){
    ui.deleteConfirmId = btn.dataset.id;
    document.getElementById('list-results').innerHTML = renderListResults();
    return;
  }
  if (action === 'cancel-delete'){
    ui.deleteConfirmId = null;
    document.getElementById('list-results').innerHTML = renderListResults();
    return;
  }
  if (action === 'confirm-delete'){
    deleteRecord(btn.dataset.id);
    return;
  }
  if (action === 'clear-review'){
    toggleReviewFlag(btn.dataset.id, false);
    return;
  }
  if (action === 'apply-teacher-fixes'){
    var checkedTeacherIds = {};
    root.querySelectorAll('.dq-teacher-check:checked').forEach(function(cb){ checkedTeacherIds[cb.dataset.id] = true; });
    var teacherFixCount = 0;
    scanTeacherMerges(ui.selectedYear).forEach(function(f){
      if (!checkedTeacherIds[f.id]) return;
      var rec = getRecord(f.id);
      if (!rec || rec.teacher !== f.original) return; // 頁面渲染後資料若已被別處改動，保守略過，不覆蓋
      rec.teacher = f.suggested;
      teacherFixCount++;
    });
    if (!teacherFixCount){ showToast('沒有勾選任何項目'); return; }
    saveAndPublish('已套用 ' + teacherFixCount + ' 筆「負責老師」拆分建議');
    return;
  }
  if (action === 'apply-date-fixes'){
    var checkedDateIds = {};
    root.querySelectorAll('.dq-date-check:checked').forEach(function(cb){ checkedDateIds[cb.dataset.id] = true; });
    var dateFixCount = 0;
    scanDateFormats(ui.selectedYear).forEach(function(d){
      if (!d.suggested || !checkedDateIds[d.id]) return;
      var rec = getRecord(d.id);
      if (!rec || rec.date !== d.original) return; // 同上，保守略過已被別處改動的記錄
      rec.date = d.suggested;
      dateFixCount++;
    });
    if (!dateFixCount){ showToast('沒有勾選任何項目'); return; }
    saveAndPublish('已套用 ' + dateFixCount + ' 筆「比賽日期」格式修正');
    return;
  }
  if (action === 'remove-teacher'){
    var teacherName = btn.dataset.teacher;
    var teacherUseCount = STATE.records.filter(function(r){ return splitTeacherNames(r.teacher).indexOf(teacherName) !== -1; }).length;
    if (teacherUseCount){
      // Removing from STATE.teachers never touches record.teacher itself
      // (see teacherFieldHTML's "其他老師" fallback), so being "in use" is
      // informational, not a reason to block the removal outright - just
      // confirm first, since a name mistakenly removed is only one click
      // away from being re-added via the settings-page form anyway.
      ui.modal = { type:'remove-teacher-confirm', name: teacherName, count: teacherUseCount };
      renderModal();
      return;
    }
    STATE.teachers = STATE.teachers.filter(function(t){ return t !== teacherName; });
    saveAndPublish('已移除教師');
    return;
  }
  if (action === 'confirm-remove-teacher'){
    var teacherName2 = btn.dataset.teacher;
    STATE.teachers = STATE.teachers.filter(function(t){ return t !== teacherName2; });
    ui.modal = null;
    saveAndPublish('已移除教師');
    return;
  }
  if (action === 'remove-subject'){
    // 2026-09-09 修訂，回應「科目分類內無法移除科目」的回饋：原本只要有任何一筆記錄使用
    // 這個科目就完全擋下移除（hard block）。但目前 10 個科目全部都至少有一筆記錄使用中
    // （163 筆舊資料涵蓋所有科目），等於這個保護機制讓移除功能形同虛設，永遠無法移除任何
    // 科目——這正是使用者回報的問題。移除科目本身**不會**去改動任何既有記錄的 `subject`
    // 欄位，只是把這個名稱從「新增/編輯記錄」的科目選單中拿掉；既有記錄仍會照樣顯示、可以
    // 編輯、被列入統計與 CSV 匯出（「按科目」列表分組本來就有針對這種情況的容錯，見
    // `groupRecordsBy`；`subjectOptions` 也已改為即使選單中沒有這個科目，仍會把記錄目前的
    // 科目值加進去並選中，避免編輯時被靜默改成別的科目）。因此仿照「移除教師」的做法，改為
    // 軟性確認：有記錄使用中時先彈出提示視窗說明影響範圍，使用者確認後才真正移除；沒有任何
    // 記錄使用的科目則維持原本的即時移除。
    var subj = btn.dataset.subject;
    var subjUseCount = STATE.records.filter(function(r){ return r.subject === subj; }).length;
    if (subjUseCount){
      ui.modal = { type:'remove-subject-confirm', subject: subj, count: subjUseCount };
      renderModal();
      return;
    }
    STATE.subjects = STATE.subjects.filter(function(s){ return s !== subj; });
    saveAndPublish('已移除科目');
    return;
  }
  if (action === 'confirm-remove-subject'){
    var subj2 = btn.dataset.subject;
    STATE.subjects = STATE.subjects.filter(function(s){ return s !== subj2; });
    ui.modal = null;
    saveAndPublish('已移除科目');
    return;
  }
  if (action === 'rename-subject'){
    // 2026-09-09 新增，回應「科目分類內無法為科目更名」的回饋：先前科目分類只支援新增／
    // 移除，沒有重新命名功能（不像獎項編號的比賽/獎項那樣有獨立、與名稱無關的 id，科目本身
    // 就是用來分類/篩選/統計的那個字串，改名需要連同所有既有記錄的 `record.subject` 一併
    // 更新，否則舊記錄會變成「用著一個已經不存在於清單裡的科目名稱」，見 `confirm-rename-
    // subject` 的實作）。
    var subj3 = btn.dataset.subject;
    ui.modal = { type:'rename-subject', subject: subj3 };
    renderModal();
    return;
  }
  if (action === 'confirm-rename-subject'){
    var oldSubj = btn.dataset.subject;
    var renameInput = document.getElementById('rename-subject-input');
    var newSubj = renameInput ? renameInput.value.trim() : '';
    if (!newSubj){ showToast('請輸入科目名稱'); return; }
    if (newSubj === oldSubj){ ui.modal = null; renderModal(); return; }
    var existingIdx = STATE.subjects.indexOf(newSubj);
    var oldIdx = STATE.subjects.indexOf(oldSubj);
    var merged = existingIdx !== -1;
    if (merged){
      // 輸入的新名稱剛好是另一個已存在的科目——當成「合併」處理：把舊科目底下的記錄全部
      // 轉移過去，並把舊科目本身從清單移除，不會留下兩個代表同一件事、卻各自獨立的科目。
      if (oldIdx !== -1) STATE.subjects.splice(oldIdx, 1);
    } else if (oldIdx !== -1){
      STATE.subjects[oldIdx] = newSubj;
    }
    var renameCount = 0;
    STATE.records.forEach(function(r){ if (r.subject === oldSubj){ r.subject = newSubj; renameCount += 1; } });
    ui.modal = null;
    var renameMsg = (merged ? '已將「' + oldSubj + '」合併到「' + newSubj + '」' : '已將「' + oldSubj + '」重新命名為「' + newSubj + '」') +
      (renameCount ? '，共更新 ' + renameCount + ' 筆記錄' : '');
    saveAndPublish(renameMsg);
    return;
  }
  if (action === 'move-subject-up'){
    moveSubject(btn.dataset.subject, -1);
    return;
  }
  if (action === 'move-subject-down'){
    moveSubject(btn.dataset.subject, 1);
    return;
  }
  if (action === 'ask-clear-year'){
    var clearSel = document.getElementById('clear-year-select');
    var clearYr = clearSel ? clearSel.value : '';
    if (!clearYr){ showToast('請先選擇要清除的學年'); return; }
    if (clearYr === STATE.meta.currentSchoolYear){ showToast('無法清除目前使用中的學年，請先在「學年管理」設定其他學年為目前學年'); return; }
    var clearRecordCount = STATE.records.filter(function(r){ return r.schoolYear === clearYr; }).length;
    var clearRosterCount = STATE.studentRosters.filter(function(r){ return r.schoolYear === clearYr; }).length;
    if (!clearRecordCount && !clearRosterCount){ showToast('「' + clearYr + '」目前沒有任何資料可以清除'); return; }
    ui.modal = { type:'clear-year', year: clearYr, recordCount: clearRecordCount, rosterCount: clearRosterCount };
    renderModal();
    return;
  }
  if (action === 'confirm-clear-year'){
    var cyInput = document.getElementById('clear-year-confirm-input');
    var typedYear = cyInput ? cyInput.value.trim() : '';
    if (!ui.modal || ui.modal.type !== 'clear-year') return;
    if (typedYear !== ui.modal.year){ showToast('請輸入正確的學年名稱以確認'); return; }
    clearYearData(ui.modal.year);
    return;
  }
  if (action === 'set-current-year'){
    STATE.meta.currentSchoolYear = btn.dataset.year;
    saveAndPublish('已設定目前學年');
    return;
  }
  if (action === 'remove-year'){
    var yr = btn.dataset.year;
    if (STATE.schoolYears.length <= 1){ showToast('至少要保留一個學年'); return; }
    var inUseYear = STATE.records.some(function(r){ return r.schoolYear === yr; });
    if (inUseYear){ showToast('「' + yr + '」仍有記錄使用中，無法移除'); return; }
    if (yr === STATE.meta.currentSchoolYear){ showToast('無法移除目前使用中的學年，請先設定其他學年為目前學年'); return; }
    STATE.schoolYears = STATE.schoolYears.filter(function(y){ return y !== yr; });
    saveAndPublish('已移除學年');
    return;
  }
  if (action === 'export-csv'){
    exportCSV();
    return;
  }
  if (action === 'export-stat'){
    exportStatByKey(btn.dataset.stat);
    return;
  }
  if (action === 'set-list-groupby'){
    ui.listGroupBy = btn.dataset.groupby;
    // Each mode's dropdown selections are meaningless in the other modes —
    // reset them so switching tabs never leaves a stale filter silently
    // gating (or un-gating) results.
    ui.listTeacherFilter = '';
    ui.listStudentClass = '';
    ui.listStudentName = '';
    ui.listSearch = '';
    render();
    return;
  }
  if (action === 'open-roster-import'){
    document.getElementById('roster-import-file-input').click();
    return;
  }
  if (action === 'open-roster-sync'){
    document.getElementById('roster-sync-file-input').click();
    return;
  }
  if (action === 'confirm-roster-sync'){
    if (!ui.modal || ui.modal.type !== 'roster-sync-preview') return;
    var syncYear = ui.modal.year;
    var syncAdded = 0, syncUpdated = 0;
    ui.modal.rows.forEach(function(r){
      var result = upsertRosterEntry(syncYear, r);
      if (result === 'added') syncAdded++; else if (result === 'updated') syncUpdated++;
    });
    var removeIdSet = {};
    ui.modal.removeIds.forEach(function(id){ removeIdSet[id] = true; });
    var removedCount = 0;
    if (ui.modal.removeIds.length){
      STATE.studentRosters = STATE.studentRosters.filter(function(r){
        if (!removeIdSet[r.id]) return true;
        removedCount++;
        return false;
      });
    }
    ui.modal = null;
    var syncMsg = '已同步「' + syncYear + '」名單：新增 ' + syncAdded + ' 位、更新 ' + syncUpdated + ' 位' +
      (removedCount ? '、移除 ' + removedCount + ' 位（不在此次檔案內）' : '');
    saveAndPublish(syncMsg);
    return;
  }
  if (action === 'confirm-roster-import'){
    if (!ui.modal || ui.modal.type !== 'roster-import-preview') return;
    var riYear = ui.modal.year;
    var riAdded = 0, riUpdated = 0;
    ui.modal.rows.forEach(function(r){
      var result = upsertRosterEntry(riYear, r);
      if (result === 'added') riAdded++; else if (result === 'updated') riUpdated++;
    });
    var riSkipped = ui.modal.skipped;
    ui.modal = null;
    var riMsg = '已匯入「' + riYear + '」名單：新增 ' + riAdded + ' 位' + (riUpdated ? '、更新 ' + riUpdated + ' 位' : '') +
      (riSkipped ? '（' + riSkipped + ' 列缺少學生編號或姓名，已略過）' : '');
    saveAndPublish(riMsg);
    return;
  }
  if (action === 'download-roster-template'){
    downloadRosterImportTemplate();
    return;
  }
  if (action === 'open-teacher-import'){
    document.getElementById('teacher-import-file-input').click();
    return;
  }
  if (action === 'confirm-teacher-import'){
    if (!ui.modal || ui.modal.type !== 'teacher-import-preview') return;
    var tiNames = ui.modal.names;
    var tiSkipped = ui.modal.skipped;
    tiNames.forEach(function(n){ STATE.teachers.push(n); });
    STATE.teachers.sort(function(a,b){ return a.localeCompare(b, 'zh-Hant'); });
    ui.modal = null;
    saveAndPublish('已匯入教師名單：新增 ' + tiNames.length + ' 位' + (tiSkipped ? '（' + tiSkipped + ' 位已經在名單內，已略過）' : ''));
    return;
  }
  if (action === 'download-teacher-template'){
    downloadTeacherImportTemplate();
    return;
  }
  if (action === 'open-club-import'){
    document.getElementById('club-import-file-input').click();
    return;
  }
  if (action === 'confirm-club-import'){
    if (!ui.modal || ui.modal.type !== 'club-import-preview') return;
    var ciYear = ui.modal.year;
    var ciAdded = 0;
    ui.modal.rows.forEach(function(r){
      var result = upsertClubEntry(ciYear, r);
      if (result === 'added') ciAdded++;
    });
    var ciRemoveIdSet = {};
    ui.modal.removeIds.forEach(function(id){ ciRemoveIdSet[id] = true; });
    var ciRemoved = 0;
    if (ui.modal.removeIds.length){
      STATE.clubRosters = STATE.clubRosters.filter(function(r){
        if (!ciRemoveIdSet[r.id]) return true;
        ciRemoved++;
        return false;
      });
    }
    var ciSkipped = ui.modal.skipped;
    ui.modal = null;
    saveAndPublish('已匯入「' + ciYear + '」課外活動名單：新增 ' + ciAdded + ' 筆' +
      (ciRemoved ? '、移除 ' + ciRemoved + ' 筆（不在此次檔案內的活動已退出成員）' : '') +
      (ciSkipped ? '（' + ciSkipped + ' 列已略過）' : ''));
    return;
  }
  if (action === 'download-club-template'){
    downloadClubImportTemplate();
    return;
  }
  if (action === 'ask-remove-club'){
    ui.clubRosterDeleteConfirmId = btn.dataset.id;
    render();
    return;
  }
  if (action === 'cancel-remove-club'){
    ui.clubRosterDeleteConfirmId = null;
    render();
    return;
  }
  if (action === 'confirm-remove-club'){
    removeClubEntry(btn.dataset.id);
    return;
  }
  if (action === 'copy-previous-roster'){
    copyPreviousRoster(ui.rosterYear || ui.selectedYear);
    return;
  }
  if (action === 'roster-prev-page'){
    if (ui.rosterPage > 1){ ui.rosterPage--; render(); }
    return;
  }
  if (action === 'roster-next-page'){
    ui.rosterPage++; render(); // 超出範圍會在 renderRosterSection 裡夾回最後一頁
    return;
  }
  if (action === 'ask-remove-roster'){
    ui.rosterDeleteConfirmId = btn.dataset.id;
    render();
    return;
  }
  if (action === 'cancel-remove-roster'){
    ui.rosterDeleteConfirmId = null;
    render();
    return;
  }
  if (action === 'confirm-remove-roster'){
    removeRosterEntry(btn.dataset.id);
    return;
  }
  if (action === 'open-bulk-import'){
    document.getElementById('bulk-import-file-input').click();
    return;
  }
  if (action === 'download-bulk-template'){
    downloadBulkImportTemplate();
    return;
  }
  if (action === 'confirm-bulk-import'){
    if (!ui.modal || ui.modal.type !== 'bulk-import-preview') return;
    var biCreated = 0, biFlagged = 0;
    ui.modal.records.forEach(function(r){
      var needsReview = false, reviewNoteParts = [];
      var subject = r.subject;
      if (!subject){ subject = STATE.subjects[0] || ''; needsReview = true; reviewNoteParts.push('批次匯入時缺少科目'); }
      if (!r.event) { needsReview = true; reviewNoteParts.push('批次匯入時缺少活動名稱'); }
      if (!r.organizer) { needsReview = true; reviewNoteParts.push('批次匯入時缺少主辦機構'); }
      if (!r.schoolYear) { needsReview = true; reviewNoteParts.push('批次匯入時缺少學年，已改用目前學年'); }
      var newAwards = r.awards.map(function(a){
        var awardSeq = STATE.nextAwardSeq; STATE.nextAwardSeq += 1;
        return { id: uid('a'), seq: awardSeq, name: a.name, type: a.type, item: a.item, recipients: a.recipients };
      });
      var newRecYear = r.schoolYear || STATE.meta.currentSchoolYear;
      // 批次匯入直接寫入 STATE.records，不經過 commitRecordFromForm，所以
      // 這裡要自己呼叫一次 attachStudentNos（見該函式說明），否則批次匯入
      // 進來的得獎人會漏掉 studentNo 比對。
      attachStudentNos(newAwards, newRecYear);
      var newRec = {
        id: uid('r'), seq: STATE.nextSeq, source:'import', createdAt: new Date().toISOString(),
        needsReview: needsReview, reviewNote: reviewNoteParts.join('；'),
        schoolYear: newRecYear,
        subject: subject, event: r.event || '', organizer: r.organizer || '',
        date: r.date || '', teacher: r.teacher || '', awards: newAwards
      };
      STATE.nextSeq += 1;
      STATE.records.push(newRec);
      biCreated++;
      if (needsReview) biFlagged++;
    });
    ui.modal = null;
    saveAndPublish('已批次匯入 ' + biCreated + ' 筆活動記錄' + (biFlagged ? '（' + biFlagged + ' 筆資料不完整，已標記為待確認）' : ''));
    return;
  }
}, false);

root.addEventListener('submit', function(e){
  if (e.target && e.target.id === 'add-edit-form'){
    e.preventDefault();
    commitRecordFromForm(e.target);
    return;
  }
  if (e.target && e.target.id === 'add-teacher-form'){
    e.preventDefault();
    var tinput = document.getElementById('new-teacher-name');
    var tname = tinput.value.trim();
    if (!tname) return;
    if (STATE.teachers.indexOf(tname) !== -1){ showToast('這位教師已經在名單內'); return; }
    STATE.teachers.push(tname);
    STATE.teachers.sort(function(a,b){ return a.localeCompare(b, 'zh-Hant'); });
    saveAndPublish('已新增教師');
    return;
  }
  if (e.target && e.target.id === 'add-subject-form'){
    e.preventDefault();
    var input = document.getElementById('new-subject-name');
    var name = input.value.trim();
    if (!name) return;
    if (STATE.subjects.indexOf(name) !== -1){ showToast('這個科目已經存在'); return; }
    STATE.subjects.push(name);
    saveAndPublish('已新增科目');
    return;
  }
  if (e.target && e.target.id === 'add-year-form'){
    e.preventDefault();
    var yinput = document.getElementById('new-year-name');
    var yname = yinput.value.trim();
    if (!yname) return;
    if (STATE.schoolYears.indexOf(yname) !== -1){ showToast('這個學年已經存在'); return; }
    STATE.schoolYears.push(yname);
    saveAndPublish('已新增學年');
    return;
  }
  if (e.target && e.target.id === 'login-form'){
    e.preventDefault();
    var pwInput = document.getElementById('login-password');
    attemptLogin(pwInput ? pwInput.value : '');
    return;
  }
  if (e.target && e.target.id === 'add-roster-form'){
    e.preventDefault();
    var year = ui.rosterYear || ui.selectedYear;
    var snInput = document.getElementById('roster-new-studentno');
    var clsInput = document.getElementById('roster-new-class');
    var noInput = document.getElementById('roster-new-no');
    var nameInput = document.getElementById('roster-new-name');
    var genderInput = document.getElementById('roster-new-gender');
    var dobInput = document.getElementById('roster-new-dob');
    addRosterEntry(
      year, snInput.value.trim(), clsInput.value.trim(), noInput.value.trim(),
      nameInput.value.trim(), genderInput.value, dobInput.value.trim()
    );
    return;
  }
  if (e.target && e.target.id === 'add-club-form'){
    e.preventDefault();
    var ccYear = ui.clubRosterYear || ui.selectedYear;
    var clubInput = document.getElementById('club-new-name');
    var clubClsInput = document.getElementById('club-new-class');
    var clubNoInput = document.getElementById('club-new-no');
    var clubNameInput = document.getElementById('club-new-studentname');
    addClubEntry(ccYear, clubInput.value.trim(), clubClsInput.value.trim(), clubNoInput.value.trim(), clubNameInput.value.trim());
    return;
  }
}, false);

root.addEventListener('change', function(e){
  if (e.target && e.target.classList && e.target.classList.contains('award-type')){
    // 切換獎項類型時，得獎人這一整欄（.recipients-col）分成三種「模式」：
    // 'student'（個人／團體，班別/學號/姓名三欄）、'teacher'（教師獎項，只有
    // 姓名一欄，可新增多筆）、'school'（學校獎項，完全不用輸入，只顯示一句
    // 自動說明文字）。只有「跨模式」切換才需要重建 DOM；'individual'／'team'
    // 之間互換都屬於 'student' 模式，資料列結構完全相同，什麼都不用做，避免
    // 使用者已經打好的班別/學號/姓名被無謂地重畫一次（雖然值會保留，但游標
    // 位置、瀏覽器自動完成狀態等還是會被打斷）。重畫時只保留每一列已輸入的
    // 姓名（且只在「兩邊都有姓名欄可延續」時才保留——從 'school' 切過來時
    // 完全沒有可延續的姓名，一律留白）；原本的班別/學號本來就跟「這個人現在
    // 是不是學生」綁在一起，沒有可以合理沿用的舊值。
    var typeBlock = e.target.closest('.award-block');
    if (typeBlock){
      var newType = e.target.value;
      var newMode = newType === 'school' ? 'school' : (newType === 'teacher' ? 'teacher' : 'student');
      var recipientsCol = typeBlock.querySelector('.recipients-col');
      var list3 = recipientsCol ? recipientsCol.querySelector('.recipients-list') : null;
      var firstRow = list3 ? list3.querySelector('.recipient-row') : null;
      // 沒有 .recipients-list 代表目前是 'school' 模式（只有說明文字，沒有
      // 任何 recipient-row）；有的話再看第一列有沒有 .rec-class 欄位判斷
      // 是 'student' 還是 'teacher'。
      var oldMode = !list3 ? 'school' : (firstRow && !firstRow.querySelector('.rec-class') ? 'teacher' : 'student');
      if (recipientsCol && newMode !== oldMode){
        if (newMode === 'school'){
          recipientsCol.innerHTML = '<div class="hint">得獎人將自動設為「' + esc(STATE.meta.schoolName || '') + '」，不需要輸入。</div>';
        } else {
          var preserved = [];
          if (list3){
            preserved = Array.prototype.slice.call(list3.querySelectorAll('.recipient-row')).map(function(row){
              var nameEl = row.querySelector('.rec-name');
              return { class:'', no:'', name: nameEl ? nameEl.value.trim() : '' };
            });
          }
          if (!preserved.length) preserved = [{ class:'', no:'', name:'' }];
          recipientsCol.innerHTML =
            '<div class="recipients-list">' + preserved.map(function(rp){ return recipientRowHTML(rp, newMode==='teacher'); }).join('') + '</div>' +
            '<button type="button" class="btn btn-sm" style="margin-top:8px" data-action="add-recipient-row">' + (newMode==='teacher' ? '+ 新增得獎老師' : '+ 新增得獎學生') + '</button>';
        }
      }
      // 「從學生名單選取」「從課外活動名單選取」這兩顆按鈕只對學生（個人/團體）
      // 有意義，切到學校獎項／教師獎項時把整個右側 .picker-col 移除；切回個人/
      // 團體、且這個獎項區塊原本沒有這一欄（原本是學校獎項或教師獎項）時才重新
      // 插入一份全新的（不需保留關閉/展開狀態，本來就是每次都從頭選班別）。
      var bodyEl = typeBlock.querySelector('.award-block-body');
      var pickerCol = typeBlock.querySelector('.picker-col');
      if (newMode !== 'student'){
        if (pickerCol) pickerCol.remove();
      } else if (!pickerCol && bodyEl){
        bodyEl.insertAdjacentHTML('beforeend', pickerColHTML());
      }
    }
    return;
  }
  if (e.target && e.target.classList && e.target.classList.contains('roster-picker-class')){
    var rpClassWrap = e.target.closest('.ms-dropdown');
    if (rpClassWrap) renderRosterPickerStudentList(rpClassWrap, e.target.value);
    return;
  }
  if (e.target && e.target.classList && e.target.classList.contains('roster-picker-student')){
    var rpStuWrap = e.target.closest('.ms-dropdown');
    if (rpStuWrap) updateRosterPickerCount(rpStuWrap);
    return;
  }
  if (e.target && e.target.classList && e.target.classList.contains('club-picker-club')){
    var cpClassWrap = e.target.closest('.ms-dropdown');
    if (cpClassWrap) renderClubPickerMemberList(cpClassWrap, e.target.value);
    return;
  }
  if (e.target && e.target.classList && e.target.classList.contains('club-picker-student')){
    var cpStuWrap = e.target.closest('.ms-dropdown');
    if (cpStuWrap) updateClubPickerCount(cpStuWrap);
    return;
  }
  if (e.target && e.target.id === 'club-roster-year-select'){
    ui.clubRosterYear = e.target.value;
    ui.clubRosterSelectedClub = ''; // the club list options depend on the year;
      // a selection from the old year may not exist (or mean something
      // different) in the new one, so reset rather than carry it over
    render();
    return;
  }
  if (e.target && e.target.id === 'club-roster-club-select'){
    ui.clubRosterSelectedClub = e.target.value;
    var clubTableBox = document.getElementById('club-roster-table');
    if (clubTableBox) clubTableBox.innerHTML = renderClubRosterTableBody();
    return;
  }
  if (e.target && e.target.id === 'club-import-file-input'){
    var clubFile = e.target.files && e.target.files[0];
    if (clubFile) handleClubImportFile(clubFile, ui.clubRosterYear || ui.selectedYear);
    e.target.value = '';
    return;
  }
  if (e.target && e.target.classList && e.target.classList.contains('teacher-check')){
    var teacherWrap2 = e.target.closest('.ms-dropdown');
    if (teacherWrap2){
      var checkedNow = Array.prototype.slice.call(teacherWrap2.querySelectorAll('.teacher-check:checked')).map(function(cb){ return cb.value; });
      var textEl = teacherWrap2.querySelector('.ms-control-text');
      textEl.textContent = teacherSelectionSummary(checkedNow);
      textEl.classList.toggle('placeholder', checkedNow.length === 0);
    }
    return;
  }
  if (e.target && e.target.id === 'f-date-native'){
    var dateField = document.getElementById('f-date');
    if (dateField && e.target.value) dateField.value = e.target.value;
    return;
  }
  if (e.target && e.target.id === 'list-subject-filter'){
    ui.listSubject = e.target.value;
    // Subject affects the 按教師/按學生 dropdown option lists too, so the
    // whole list view — not just the results — needs to re-render.
    render();
    return;
  }
  if (e.target && e.target.id === 'list-month-filter'){
    ui.listMonth = e.target.value;
    // Month also affects the 按教師/按學生 dropdown option lists (and the
    // 無法辨識日期 hint above the results), so re-render the whole list view.
    render();
    return;
  }
  if (e.target && e.target.id === 'list-teacher-filter'){
    ui.listTeacherFilter = e.target.value;
    document.getElementById('list-results').innerHTML = renderListResults();
    return;
  }
  if (e.target && e.target.id === 'list-student-class-filter'){
    ui.listStudentClass = e.target.value;
    ui.listStudentName = ''; // the name dropdown is scoped to the class, so a stale pick can't survive a class change
    render();
    return;
  }
  if (e.target && e.target.id === 'list-student-name-filter'){
    ui.listStudentName = e.target.value;
    document.getElementById('list-results').innerHTML = renderListResults();
    return;
  }
  if (e.target && e.target.id === 'list-only-review'){
    ui.listOnlyReview = e.target.checked;
    render();
    return;
  }
  if (e.target && e.target.id === 'year-select'){
    ui.selectedYear = e.target.value;
    ui.expandedId = null;
    render();
    return;
  }
  if (e.target && e.target.id === 'import-file-input'){
    var file = e.target.files && e.target.files[0];
    if (file) handleImportFile(file);
    e.target.value = '';
    return;
  }
  if (e.target && e.target.id === 'roster-year-select'){
    ui.rosterYear = e.target.value;
    ui.rosterPage = 1; // 換學年後名單內容完全不同，頁碼歸零重新開始
    render();
    return;
  }
  if (e.target && e.target.id === 'roster-import-file-input'){
    var rfile = e.target.files && e.target.files[0];
    if (rfile) handleRosterImportFile(rfile, ui.rosterYear || ui.selectedYear);
    e.target.value = '';
    return;
  }
  if (e.target && e.target.id === 'roster-sync-file-input'){
    var sfile = e.target.files && e.target.files[0];
    if (sfile) handleRosterSyncFile(sfile, ui.rosterYear || ui.selectedYear);
    e.target.value = '';
    return;
  }
  if (e.target && e.target.id === 'teacher-import-file-input'){
    var tfile = e.target.files && e.target.files[0];
    if (tfile) handleTeacherImportFile(tfile);
    e.target.value = '';
    return;
  }
  if (e.target && e.target.id === 'bulk-import-file-input'){
    var bfile = e.target.files && e.target.files[0];
    if (bfile) handleBulkImportFile(bfile);
    e.target.value = '';
    return;
  }
}, false);

var onListSearch = debounce(function(e){
  ui.listSearch = e.target.value;
  document.getElementById('list-results').innerHTML = renderListResults();
}, 180);

var onStudentSearch = debounce(function(e){
  ui.studentSearch = e.target.value;
  var box = document.getElementById('student-search-results');
  if (box) box.innerHTML = renderStudentSearchResults();
}, 180);

var onClubRosterFilter = debounce(function(e){
  ui.clubFilterQuery = e.target.value;
  var box = document.getElementById('club-roster-table');
  if (box) box.innerHTML = renderClubRosterTableBody();
}, 180);

root.addEventListener('input', function(e){
  if (e.target && e.target.id === 'list-search'){
    onListSearch(e);
  }
  if (e.target && e.target.id === 'student-search'){
    onStudentSearch(e);
  }
  if (e.target && e.target.id === 'club-roster-filter'){
    onClubRosterFilter(e);
  }
  if (e.target && e.target.classList && e.target.classList.contains('ms-search')){
    var q = e.target.value.trim();
    var panel = e.target.closest('.ms-panel');
    var opts = panel.querySelectorAll('.ms-option');
    for (var i = 0; i < opts.length; i++){
      var match = !q || opts[i].textContent.indexOf(q) !== -1;
      opts[i].style.display = match ? '' : 'none';
    }
  }
}, false);

/* ============================================================
   Init — 2026-09-21 GitHub + Firebase 版本
   ------------------------------------------------------------
   原本（Claude Artifact 版本）STATE 在檔案一開頭就同步讀好了，這裡只需要立刻
   render() 一次、再非同步確認一下有沒有寫入權限。Firebase 版本的 STATE 要等
   Google 登入 + Firestore 四個來源的資料都到齊才存在，所以在那之前先顯示
   登入畫面／載入中畫面（直接寫 root.innerHTML，不透過 render()，因為 render()
   內部的 renderShell() 假設 STATE 已經是完整資料，STATE 還是 null 時呼叫會出錯）。
   ============================================================ */

var currentUserEmail = '';
var appStarted = false;
var loadedFlags = { records:false, studentRosters:false, clubRosters:false, settings:false };
var pendingData = { records:[], studentRosters:[], clubRosters:[], settings:null };
var stopListening = null;

function renderGateScreen(innerHtml){
  root.innerHTML =
    '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--color-surface-2)">' +
      '<div class="card card-pad stack" style="max-width:420px;width:100%;text-align:center;">' + innerHtml + '</div>' +
    '</div>';
}

function renderLoadingGate(msg){
  renderGateScreen(
    '<h2 style="margin-bottom:6px">學生獲獎紀錄系統</h2>' +
    '<div class="hint">' + esc(msg || '載入資料中…') + '</div>'
  );
}

function renderLoginGate(errorMsg){
  var domain = (window.fbApi && window.fbApi.ALLOWED_DOMAIN) || 'lwcps.edu.hk';
  renderGateScreen(
    '<h2 style="margin-bottom:6px">學生獲獎紀錄系統</h2>' +
    '<div class="hint" style="margin-bottom:16px">請使用 @' + esc(domain) + ' 的 Google 帳號登入</div>' +
    (errorMsg ? '<div class="banner banner-warn" style="margin-bottom:12px">' + esc(errorMsg) + '</div>' : '') +
    '<button class="btn btn-primary" type="button" id="google-signin-btn" style="width:100%">使用 Google 帳號登入</button>'
  );
  var btn = document.getElementById('google-signin-btn');
  if (btn) btn.addEventListener('click', function(){
    btn.disabled = true;
    window.fbApi.signIn().catch(function(err){
      renderLoginGate(err && err.message ? err.message : '登入失敗，請再試一次');
    });
  });
}

// 把四個 Firestore 來源組回 STATE 的形狀，交給 migrateState() 做一次完整的防呆/
// 搬移處理（見該函式上方註解）——只在「第一次全部到齊」時跑這一次。
function maybeStartApp(){
  if (appStarted) return;
  if (!loadedFlags.records || !loadedFlags.studentRosters || !loadedFlags.clubRosters || !loadedFlags.settings) return;
  appStarted = true;
  var settings = pendingData.settings || {};
  var rawState = {
    meta: { schoolName: settings.schoolName || '學校', currentSchoolYear: settings.currentSchoolYear || '' },
    schoolYears: settings.schoolYears || [],
    subjects: settings.subjects || [],
    teachers: settings.teachers || [],
    records: pendingData.records,
    studentRosters: pendingData.studentRosters,
    clubRosters: pendingData.clubRosters
  };
  STATE = migrateState(rawState);
  firestoreMirror = stateToMirrorShape(STATE);
  ui.selectedYear = STATE.meta.currentSchoolYear;
  render();
}

// 之後每次某個集合有變動（不論是自己存檔、還是別人存檔同步回來的），走這裡輕量
// 更新 STATE 對應的欄位即可，不重跑 migrateState()（原因見該函式上方註解）。
function mergeCollection(key, arr){
  pendingData[key] = arr;
  loadedFlags[key] = true;
  if (!appStarted){ maybeStartApp(); return; }
  if (key === 'studentRosters'){
    arr = arr.map(function(r){
      if (r.studentNo === undefined) r.studentNo = '';
      if (r.gender === undefined) r.gender = '';
      if (r.dob === undefined) r.dob = '';
      return r;
    });
  }
  STATE[key] = arr;
  firestoreMirror = stateToMirrorShape(STATE);
  render();
}

function mergeSettings(settingsObj){
  pendingData.settings = settingsObj || {};
  loadedFlags.settings = true;
  if (!appStarted){ maybeStartApp(); return; }
  var s = pendingData.settings;
  if (s.schoolName) STATE.meta.schoolName = s.schoolName;
  if (s.currentSchoolYear) STATE.meta.currentSchoolYear = s.currentSchoolYear;
  if (Array.isArray(s.schoolYears)) STATE.schoolYears = s.schoolYears;
  if (Array.isArray(s.subjects)) STATE.subjects = s.subjects;
  if (Array.isArray(s.teachers)) STATE.teachers = s.teachers.slice().sort(function(a,b){ return a.localeCompare(b,'zh-Hant'); });
  firestoreMirror = stateToMirrorShape(STATE);
  render();
}

renderLoadingGate('初始化中…');

if (!window.fbApi){
  renderGateScreen('<h2 style="margin-bottom:6px">設定錯誤</h2><div class="hint">找不到 Firebase 設定（firebase-config.js 未正確載入），請聯絡系統管理員。</div>');
} else {
  window.fbApi.onAuthChange(function(user){
    if (!user){
      appStarted = false;
      STATE = null;
      firestoreMirror = null;
      loadedFlags = { records:false, studentRosters:false, clubRosters:false, settings:false };
      if (stopListening){ stopListening(); stopListening = null; }
      renderLoginGate();
      return;
    }
    currentUserEmail = user.email || '';
    renderLoadingGate('載入資料中…');
    stopListening = window.fbApi.startListening({
      records: function(arr){ mergeCollection('records', arr); },
      studentRosters: function(arr){ mergeCollection('studentRosters', arr); },
      clubRosters: function(arr){ mergeCollection('clubRosters', arr); },
      settings: function(obj){ mergeSettings(obj); },
      error: function(err){
        console.error('[firebase] 同步失敗', err);
        showToast('資料同步發生問題：' + (err && err.message ? err.message : '未知錯誤'), 4200);
      }
    });
  });
}

})();
