/* ===== 設定 ===== */
const BASIC_ID = '144egfxu';
const UPDATED  = '2025-09-20';
/* =============== */

// ページアクセス時のあいさつ文
const NAVI_GREETING =
  '初めまして。n▲▼i（ナビ）です。奇録会の報告書を、一緒に読み解くお手伝いをしますね。' +
  ' まずは、奇録会の公式LINEで出された問（例：行方不明者の根拠）を、この下の入力欄に入れてみてくださいね。';

// 画像パス（任意の場所にアップして差し替えOK）
const NAVI_AVATAR_URL = '/img/navi-avatar.png';   // nAVi のアイコン画像

let linePayload = ''; // ← LINEに渡す最終テキスト

// HTMLをテキストに（サマリーを送信用に整形）
function plainTextFromHTML(html=''){
  const div = document.createElement('div');
  div.innerHTML = html;
  const text = div.textContent || div.innerText || '';
  // 連続スペース圧縮＆改行整形
  return text.replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').replace(/[ \t]+/g,' ').trim();
}

// サマリー本文からLINEに送る文面を作る（必要ならここで文面デザイン）
function buildLinePayload(summaryText){
  const head = currentKeyword ? `【${currentKeyword}】` : '【回答】';
  // 文字数はOA側ディープリンクに収まる程度で truncate
  const body = summaryText.length > 480 ? (summaryText.slice(0,477) + '…') : summaryText;
  return `${head}\n${body}`;
}

// 直近のnAViバブルに「LINEで送る」ボタンを付与
function attachLineButtonToLastnAVi(){
  const bubble = chat.querySelector('.msg.nAVi:last-of-type .bubble');
  if(!bubble) return;
  const actions = document.createElement('div');
  actions.className = 'actions';
  const a = document.createElement('a');
  a.textContent = 'LINEで送る';
  a.href = '#';
  a.onclick = (e)=>{
    e.preventDefault();
    smartLineOpen(linePayload || currentKeyword || '回答');
    resetFlow(true);   // ← ボタン押したら会話をリセット
  };

  actions.appendChild(a);
  bubble.appendChild(actions);
  scrollToBottom();
}

/* ヒントボタンを最後の nAVi 吹き出しに付与 */
function attachHintButtonsToLastnAVi(hints){
  if (!Array.isArray(hints) || hints.length === 0) return;

  const bubble = chat.querySelector('.msg.nAVi:last-of-type .bubble');
  if (!bubble) return;

  const wrap = document.createElement('div');
  wrap.className = 'hint-buttons';

  hints.forEach(h => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hint-btn';
    btn.textContent = h.label || 'ヒント';
    btn.addEventListener('click', () => {
      sendHintRequest(h.id);
    });
    wrap.appendChild(btn);
  });

  bubble.appendChild(wrap);
  scrollToBottom();
}

/* 1vh補正（スマホのアドレスバー対策） */
function setVH(){ document.documentElement.style.setProperty('--vh', `${window.innerHeight*0.01}px`); }
setVH(); addEventListener('resize', setVH); addEventListener('orientationchange', setVH);

const updatedEl = document.getElementById('updated');
if (updatedEl) updatedEl.textContent = UPDATED;

const form = document.getElementById('startForm');
const chat = document.getElementById('chat');
const kwInput = document.getElementById('kw');

let currentKeyword = '';
let currentStep    = '_start';
let context        = {};

/* 送信 */
form.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const text = kwInput.value.trim();
  if(!text) return;

  // ★ リセットコマンド
  if(text === '別の回答を考える'){
    resetFlow(true);
    kwInput.value = '';
    return;
  }

  // 1回目：キーワード検証
  if(!currentKeyword){
    addMsg('you', `<strong>${escapeHTML(text)}</strong>`);
    await askServer({ answer: '', overrideKeyword: text, initial: true }); // 仮キーワードで問い合わせ
    kwInput.value = '';
    scrollToBottom();
    return;
  }

  // 2回目以降：プレイヤー回答
  addMsg('you', `<strong>${escapeHTML(text)}</strong>`);
  await askServer({ answer: text });
  kwInput.value = '';
  scrollToBottom();
});

/* ヒントボタンからの問い合わせ */
async function sendHintRequest(hintIndex){
  // ユーザーの吹き出しは追加しない（nAVi だけ返す）
  await askServer({ answer: '', hintIndex: Number(hintIndex) });
}

/* サーバ問い合わせ（nAViはタイプ表示→本文打刻） */
async function askServer({ answer='', overrideKeyword=null, initial=false, hintIndex=null } = {}){
  const k = overrideKeyword ?? currentKeyword;

  try{
    const payload = { keyword: k, step: currentStep, answer, context };
    if (hintIndex !== null && !Number.isNaN(hintIndex)) {
      payload.hintIndex = hintIndex;
    }

    const res = await fetch('/.chat', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });

    // 404などもJSONを読んで分岐
    const data = await res.json().catch(()=> ({}));

    // 初回キーワード検証フェーズ
    if(initial){
      if(!res.ok || data.ok === false || data.error === 'not_found'){
        addMsg(
          'nAVi',
          'ごめんなさい。このナビサイトは、奇録会公式LINEから案内されたキーワードだけに反応するように設定されています。' +
          ' 奇録会公式LINEで届いた言葉を、そのまま入力してみてくださいね。'
        );
        return;
      }
      // OKだったので確定
      currentKeyword = k;
    }else if(!res.ok){
      throw new Error('bad response');
    }

    // 表示（nAViはタイプ表示）
    if(data.role && data.prompt){
      if(data.role === 'nAVi'){
        await nAViSay(data.prompt, 2000, 18);

        // 不正解時など、ヒントボタンが返ってきたら付与
        if (Array.isArray(data.hints) && data.hints.length > 0) {
          attachHintButtonsToLastnAVi(data.hints);
        }
      }else{
        addMsg(data.role, escapeHTML(data.prompt));
      }
    }

    // サマリー直後にLINEボタン
    if (data.next === 'confirm' && data.prompt) {
      const summaryPlain = plainTextFromHTML(data.prompt);
      linePayload = buildLinePayload(summaryPlain);
      attachLineButtonToLastnAVi();
    }

    if(data.context) context = data.context;
    if(data.next) currentStep = data.next;

    if (data.sendText) {
      linePayload = data.sendText;   // ← これを LINE に送る
    }

    if(currentStep === 'end'){
      smartLineOpen(linePayload || currentKeyword || '回答');
      resetFlow(false);
    }
  }catch(err){
    // 初回で落ちた場合は確定させない
    if(initial) {
      addMsg('nAVi','通信エラーが発生しました。時間をおいて再度お試しください。');
      return;
    }
    addMsg('nAVi','通信エラーが発生しました。時間をおいて再度お試しください。');
  }
}

/* nAViのタイプ表示 */
function nAViSay(text, waitMs=2000, cps=20){
  return new Promise(resolve=>{
    // タイピング中のメッセージを出す
    const item = document.createElement('div');
    item.className = 'msg nAVi';
    const av = document.createElement('div'); 
    av.className = 'avatar';
    const img = document.createElement('img');
    img.className = 'avatarimg';
    img.src = NAVI_AVATAR_URL;
    img.alt = 'nAVi';
    img.onerror = ()=>{ av.textContent = 'n'; av.classList.add('avatar-fallback'); };
    av.appendChild(img);

    const bubble = document.createElement('div'); bubble.className = 'bubble';
    bubble.innerHTML = `<span class="typing"></span>`;

    item.appendChild(av); item.appendChild(bubble); chat.appendChild(item);
    scrollToBottom();

    // 待ってから本文をタイプアウト
    setTimeout(()=>{
      const plain = escapeHTML(text);
      bubble.textContent = ''; // 消してタイプ開始
      let i = 0;
      const tick = () => {
        bubble.innerHTML = plain.slice(0, i++);
        scrollToBottom();
        if(i <= plain.length){ setTimeout(tick, Math.max(8, 1000/cps)); }
        else resolve();
      };
      tick();
    }, waitMs);
  });
}

function rendernAViBlock(payload){
  // 直前の「少々お待ちください…」を消して差し替え
  const last = chat.querySelector('.msg.nAVi:last-of-type .bubble');
  if(last && last.textContent.includes('...')) last.parentElement.remove();

  // 導入テキスト
  if(payload.intro) addMsg('nAVi', escapeHTML(payload.intro));

  // 段階ヒント
  if(Array.isArray(payload.hints)){
    const wrap = document.createElement('div');
    wrap.className = 'msg nAVi';
    const b = document.createElement('div');
    b.className = 'bubble';
    const grid = document.createElement('div');
    grid.className = 'hints';
    payload.hints.forEach(h=>{
      const d = document.createElement('div');
      d.className = 'hint';
      d.innerHTML = `<small>${escapeHTML(h.tag)}</small>${escapeHTML(h.text)}`;
      grid.appendChild(d);
    });
    const actions = document.createElement('div'); actions.className = 'actions';

    // oaMessage（スマホ） or 友だち追加（PC）スマートボタン
    const btn = document.createElement('a');
    btn.textContent = `LINEで「${payload.lineKeyword}」を送る`;
    btn.href = '#';
    btn.onclick = (e)=>{
      e.preventDefault();
      smartLineOpen(payload.lineKeyword);
    };
    actions.appendChild(btn);

    b.appendChild(grid); b.appendChild(actions);
    wrap.appendChild(b); chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
  }

  // 追加メッセージ（任意）
  if(Array.isArray(payload.messages)){
    payload.messages.forEach(m=>{
      addMsg(m.role === 'you' ? 'you' : 'nAVi', escapeHTML(m.content));
    });
  }
}

/* メッセージ追加 */
function addMsg(side, html){
  const item = document.createElement('div');
  item.className = `msg ${side}`;
  if(side === 'nAVi'){
    const av = document.createElement('div'); av.className = 'avatar';
    const img = document.createElement('img');
    img.className = 'avatarimg';
    img.src = NAVI_AVATAR_URL;
    img.alt = 'nAVi';
    img.onerror = ()=>{ av.textContent = 'n'; av.classList.add('avatar-fallback'); };
    av.appendChild(img);
    item.appendChild(av);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = html;
  item.appendChild(bubble);
  chat.appendChild(item);
}

/* 下端へ */
function scrollToBottom(){ chat.scrollTop = chat.scrollHeight; }

/* 初期化（必要に応じて案内メッセージ） */
function resetFlow(showNotice){
  currentKeyword = '';
  currentStep    = '_start';
  context        = {};
  linePayload    = '';         // ← クリア
  if(showNotice){
    addMsg('nAVi','ありがとうございます。それでは別の問について考えましょうか。新しいキーワードを入力してください。');
    scrollToBottom();
  }
}

/* ユーティリティ */
function escapeHTML(s=''){
  return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// スマホ：oaMessage、PC：コピー＋友だち追加
const isMobile = ()=> /iPhone|iPad|Android/i.test(navigator.userAgent);
function smartLineOpen(label){
  const add = `https://line.me/R/ti/p/%40${BASIC_ID}`;
  const oa  = `https://line.me/R/oaMessage/%40${BASIC_ID}/?${encodeURIComponent(label)}`;
  if(isMobile()){
    window.open(oa,'_blank','noopener');
  }else{
    try{ navigator.clipboard.writeText(label); }catch(_){}
    window.open(add,'_blank','noopener');
    alert('キーワードをコピーしました。LINEで貼り付けて送信してください。');
  }
}

// ページ読み込み時に nAVi のあいさつを表示
window.addEventListener('load', () => {
  nAViSay(NAVI_GREETING, 500, 18);
});
