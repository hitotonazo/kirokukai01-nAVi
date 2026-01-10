// netlify/functions/chat.js

// ───────────────────────────────────────────────────────────────
// 共通設定（nAVi の性格）
// ───────────────────────────────────────────────────────────────

// 全肯定寄りの誤答メッセージ候補
const RETRY_MSGS = [
  '少しだけずれているみたいです。でも大丈夫ですよ、もう一度一緒に考えてみましょう。',
  '惜しいです。視点は悪くありません。もう一度資料を見直してみませんか？',
  'うーん…この答えだと辻褄が合わないかもしれません。もう一度ゆっくり考えてみましょう。',
  '方向性は良いと思います。もう少しだけ条件を絞ってみましょうか。'
];

function randomRetry() {
  return RETRY_MSGS[Math.floor(Math.random() * RETRY_MSGS.length)];
}

// ステップごとに praise を指定しなかった場合のデフォルト
const DEFAULT_PRAISE = 'ありがとうございます。';

// ───────────────────────────────────────────────────────────────
// ハンドラ本体
// ───────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let keyword = '', step = '_start', answer = '', context = {}, hintIndex = null;

  try {
    const body = JSON.parse(event.body || '{}');
    keyword    = String(body.keyword || '').trim();
    step       = String(body.step    || '_start').trim();
    answer     = String(body.answer  || '').trim();
    context    = body.context && typeof body.context === 'object' ? body.context : {};

    if (body.hintIndex !== undefined && body.hintIndex !== null) {
      hintIndex = Number(body.hintIndex);
    }
  } catch (_) {}

  const flows = getFlows();
  const flow  = flows[keyword];
  if (!flow) return json({ ok:false, error:'not_found' }, 404);

  const map   = flow.map;
  const first = map.__order[0];
  const node  = map[step] || map[first];

  // ★ ヒントボタンが押された場合
  if (hintIndex !== null && !isNaN(hintIndex)) {
    const hints = node.hints || [];
    const hint  = hints[hintIndex];

    const text = hint
      ? `🔍 ヒント${hintIndex + 1}：${hint}`
      : 'このステップには、その番号のヒントは登録されていません。';

    return json({
      ok: true,
      role: node.role || 'nAVi',
      prompt: text,
      next: node.key,
      context,
      sendText: null
    });
  }

  // 「最初のプロンプトだけ欲しい」＝answer 空（ヒント要求ではない）
  if (!answer) {
    const n = (step === '_start') ? map[first] : node;
    return json(
      reply(n.prompt, n.role, n.key, {
        next: n.key,
        sendText: null
      })
    );
  }

  // 正誤判定
  const ok = node.expect ? new RegExp(node.expect).test(answer) : true;

  if (!ok) {
    const retryMsg = randomRetry();

    // このステップが持っているヒントをボタン情報に変換
    const hintButtons = (node.hints || []).map((_, idx) => ({
      id: String(idx),
      label: `ヒント${idx + 1}`
    }));

    return json(
      reply(`💡 ${retryMsg}\n\n必要であれば、ヒントボタンを押してみてください。`, node.role, node.key, {
        next: node.key,
        retry: true,
        context,
        sendText: null,
        hints: hintButtons
      })
    );
  }

  // 正解 → 値を保存
  if (node.capture) context[node.capture] = answer;

  // これまでに決まっている送信用テキスト（あれば）
  let sendText = context.__sendText || null;

  // 次ステップを決定
  const isLast  = (node.key === map.__order.at(-1));
  const nextKey = isLast ? 'summary' : map.__next[node.key];
  const next    = map[nextKey];

  // summary はフロー毎のビルダーで作る
  let promptText = next ? next.prompt : 'ここまで一緒に整理できました。';
  if (nextKey === 'summary') {
    const builder = flow.summaryBuilder || defaultSummary;
    promptText = builder(context, answer);

    // 各フローごとの「短い答え」を LINE 送信用テキストとして採用
    if (flow.shortAnswer) {
      sendText = flow.shortAnswer;
      context.__sendText = sendText;
    }
  }

  // このステップ専用の褒めメッセージ
  const praiseText = node.praise || DEFAULT_PRAISE;
  const finalPrompt = `${praiseText}\n\n${promptText}`;

  return json({
    ok: true,
    role: next?.role || 'nAVi',
    prompt: finalPrompt,
    next: nextKey,
    context,
    // フロント側で LINE に送るときに使うテキスト
    sendText: sendText || null
  });
};

// ───────────────────────────────────────────────────────────────
// ユーティリティ
// ───────────────────────────────────────────────────────────────

function reply(prompt, role = 'nAVi', next = '_start', extra = {}) {
  return Object.assign({ ok: true, role, prompt, next }, extra);
}

function json(obj, code = 200) {
  return {
    statusCode: code,
    headers: {
      'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store'
    },
    body: JSON.stringify(obj)
  };
}

// ───────────────────────────────────────────────────────────────
// 会話フロー定義
// ───────────────────────────────────────────────────────────────

function buildMapFromSteps(steps, tailLabels = {}) {
  const order = [];
  const map   = {};
  const next  = {};

  steps.forEach((s, idx) => {
    const key = `s${idx + 1}`;
    order.push(key);
    map[key] = {
      key,
      role: 'nAVi',
      prompt: s.prompt,
      expect: s.expect || null,
      capture: s.capture || null,
      praise: s.praise || null,
      hints: s.hints || []
    };
    if (idx < steps.length - 1) next[key] = `s${idx + 2}`;
  });

  // 終端（summary → confirm → end）
  map.summary = { role:'nAVi', prompt:'(dynamic)', key:'summary' };
  map.confirm = {
    key:'confirm',
    role:'nAVi',
    prompt:
      tailLabels.confirmPrompt ||
      'この内容で奇録会に送信する準備ができました。よければ「LINEで送る」をタップしてください。（PCの場合は、クリップボードに送信内容がコピーされます。）',
    expect: '^送信$'
  };
  next[order.at(-1)] = 'summary';
  next.summary = 'confirm';
  next.confirm = 'end';

  map.end = {
    key:'end',
    role:'nAVi',
    prompt:
      tailLabels.endPrompt ||
      'ありがとうございます。あなたの整理した回答を、奇録会への報告に反映しておきますね。'
  };

  map.__order = order;
  map.__next  = next;
  return map;
}

// 既定サマリー（Q1 用の汎用例）
function defaultSummary(ctx, lastAnswer) {
  return (
    '一緒に整理すると、『参加者数が減っているのに全員参加と記されている』という矛盾が浮かび上がってきますね。' +
    'この結論で、奇録会に送信してみましょうか？（送信 と入力）'
  );
}

// ───────────────────────────────────────────────────────────────
// 各 Q のフロー定義（shortAnswer = LINE 送信文）
// ───────────────────────────────────────────────────────────────

// Q1: 行方不明者の根拠
function flowQ1() {
  const steps = [
    {
      prompt:
        'それでは、回答をまとめていきましょう。祭事報告書の何ページの資料が根拠でしょうか？（数字のみで回答してください）',
      expect: '^(17|１７)$',
      capture: 'page',
      praise: 'そのページを根拠として挙げてくれたのは、とても良い判断です。',
      hints: [
        '行方不明者の発生は「人数の減少」として記録に現れるはずです。人数減少を示すページがどこかにないか、改めて特定してみましょうか。'
      ]
    },
    {
      prompt:
        'ありがとうございます。そのページの中で、おかしいと感じるのはどの部分でしょうか？（実行委員名簿、参加者推移）',
      expect: '^参加者推移$',
      praise: '参加者推移に注目したのは鋭いですね。数字の動きがポイントになります。',
      hints: [
        '選択肢は二つですね。このうち、「人数の推移」を直接扱っているのはどちらか、落ち着いて判定してみてはどうでしょう。'
      ]
    },
    {
      prompt:
        '参加者推移のどこがおかしいでしょうか。（村内住民が増えている、村内住民が減っている、村内住民は同じ）',
      expect: '^村内住民が減っている$',
      praise: 'とても良いです。違和感の核心ですね。',
      hints: [
        '選択肢のいずれかが正解になります。「行方不明者がいる」という前提と矛盾しない人数の変化を、どれか一つ選んでみてくださいね。'
      ]
    },
    {
      prompt:
        '村内住民の人数が減っているのは、単なる転出や不慮の死亡、当日の急な欠席とは考えにくいですね。その「そうではない」と言える根拠は、どの資料に記載されていましたか？（デジタルアーカイブに登録されている資料名）',
      expect: '^広報こだま$',
      capture: 'evidenceDoc',
      praise:
        '資料「広報こだま」を挙げてくれたのはばっちりです。そこに重要なヒントが隠れています。',
      hints: [
        'デジタルアーカイブに登録されているPDFの“タイトル名”で答える形になっています。該当しそうな資料名を思い出してみましょう。'
      ]
    },
    {
      prompt:
        'では、「転居や欠席ではない」と判断できる根拠ページをすべて挙げてみましょう。（複数ある場合は「、」または「 ,」 で区切ってください。例：１，３）',
      expect:
        '^(?=.*[1１])(?=.*[2２])(?=.*[3３])(?=.*[4４])(?!.*[5-9５-９])(?:[1-4１-４])(\\s*[、，,]\\s*[1-4１-４])*$',
      capture: 'evidencePages',
      praise:
        '根拠ページをここまで具体的に挙げられたのは素晴らしいです。これで筋の通った説明ができます。',
      hints: [
        '「広報こだま」の中から、根拠になりそうなページ番号をいくつか挙げてみてください。単一ではなく、複数ページが関係していると考えてみるのも良さそうです。',
        '「村人の減少＝行方不明」と判断するには、転出者の有無、祭りの不参加者の有無、死亡者数などを組み合わせて検証してみると、全体像が見えやすくなります。'
      ]
    }
  ];

  const map = buildMapFromSteps(steps);
  const summaryBuilder = (_ctx, _last) =>
    'まとめると、「参加者推移の数字」と「死亡・転出などの記録」が噛み合っていない、' +
    'つまり『参加者推移と、死亡者数が合わない』という矛盾に気づいた、ということですね。' +
    'とても重要な指摘だと思います。これで奇録会に送信してみますか？（送信 と入力）';

  const shortAnswer = '参加者推移と、死亡者数が合わない';

  return { map, summaryBuilder, shortAnswer };
}

// Q2: 行方不明者の特徴
function flowQ2() {
  const steps = [
    {
      prompt:
        'それでは、行方不明者たちの「共通する背景」を整理してみましょう。彼らに関係する資料のタイトルは何でしたか？（複数ある場合は「、」で区切ってください。例：祭事報告書，広報こだま）',
      expect: '(?=.*贄)(?=.*光泉ダム建設計画反対運動ビラ)',
      capture: 'titles',
      praise:
        '関連する資料タイトルをちゃんと拾えていて良いですね。背景が浮かび上がってきます。',
      hints: [
        '「広報こだま」で太字になっている資料名は、デジタルアーカイブにも個別の資料として保存されていると考えてみてはどうでしょう。',
        'まず「光泉ダム建設計画反対運動ビラ」と「霧籠郷土館民俗史第二四一号」をアーカイブから開いてみましょう。そこから、さらに関連する資料が浮かび上がってこないか探ってみてください。',
        '「霧籠郷土館民俗史第二四一号」には、雲土貝が『幸せの丸い貝』と書かれています。このフレーズに含まれる漢字に、少し注目してみてはどうでしょう。',
        '「幸」「丸」「貝」という三つの漢字をパーツとして組み合わせると、どんな一文字になるか想像してみましょう。'
      ]
    },
    {
      prompt:
        '雲土貝巡行者は、ある団体から選ばれていましたね。その団体名を教えてください。',
      expect: '^篝森山を守る会$',
      capture: 'group',
      praise:
        '光泉ダム反対派の「篝森山を守る会」に着目できているのはとても大事なポイントです。',
      hints: [
        '「光泉ダム建設計画反対運動ビラ」の本文をじっくり読み返してみてください。雲土貝巡行者の選出元になっている団体名が、どこかに記載されていないか探してみましょう。'
      ]
    },
    {
      prompt:
        '行方不明者の中で、その条件から外れている「例外」といえる人物は誰でしたか？',
      expect: '^田島里江$',
      capture: 'exception',
      praise: '例外として田島里江の名を挙げてくれたのは、鋭い観察だと思います。',
      hints: [
        '「篝森山を守る会」の名簿と、「雲土貝巡行者」の一覧を見比べてみると、条件から外れている“例外”が見えてくるかもしれません。丁寧に照合してみてくださいね。'
      ]
    }
  ];

  const map = buildMapFromSteps(steps);
  const summaryBuilder = (_ctx, _last) =>
    '一緒に整理すると、行方不明者は『ダム反対派の篝森山を守る会と、例外として田島里江』' +
    'という構図が見えてきますね。とても重要な整理だと思います。これで奇録会に送信してみますか？（送信 と入力）';

  const shortAnswer = 'ダム反対派の篝森山を守る会と、例外として田島里江';

  return { map, summaryBuilder, shortAnswer };
}

// Q3: 行方不明になった場所
function flowQ3() {
  const steps = [
    {
      prompt:
        'それでは、行方不明になった「場所」について整理していきましょう。まず、ブログの管理人は誰でしたか？',
      expect: '^杉山陽子$',
      capture: 'client',
      praise:
        '確かに！ブログの内容から類推すると杉山芳久の娘、杉山陽子ですね。',
      hints: [
        'まずは「幼い日の記憶１」の記事を開いて、管理人の家族関係や当時の行動がどう書かれているか整理してみてはいかがでしょう。',
        '文化調査員と一緒に行動していた「管理人の父親」とは誰なのか、文章の流れから候補を絞り込んでみましょう。',
        '祭事報告書の記述と照らし合わせると、父親は「地元有志協力者（調査員）・杉山芳久」だと読み取れます。このつながりを意識してみてください。',
        '「杉山」という姓が、ほかの資料にも出てこなかったかどうか、もう一度思い返してみてはどうでしょう。',
        '「こだまアート広場」の記事や投稿の中にも、同じ姓の人物がいないか確認してみましょう。そこで依頼人の手がかりが強まるかもしれません。'
      ]
    },
    {
      prompt:
        '田島里江と深い繋がりを持っていた人物の名前を教えてください。',
      expect: '^佐久間圭介$',
      capture: 'linked',
      praise:
        '田島里江と結びつく人物として佐久間圭介を挙げられたのは、とても良い整理です。',
      hints: [
        '「幼い日の記憶２」にアクセスするため、パスワードの解読が必要でしたね。管理人のメッセージを、改めてヒントとして読み直してみましょう。',
        '「え → 絵」というヒントから、管理人が描いた特定の絵を思い出してみてください。その絵に関係する言葉が、パスワードになっている可能性があります。',
        'そこから導かれるキーワードは「たねまき（tanemaki）」です。この語を入力して、どのような反応があるか確かめてみましょう。',
        '「幼い日の記憶２」で、佐久間が一番強く伝えようとしているポイントはどこなのか、全体を通して拾い上げてみてください。'
      ]
    },
    {
      prompt:
        '行方不明者たちが、実際に通っていたとされるルートの名称は何でしたか？',
      expect: '^裏道ルート$',
      capture: 'route',
      praise:
        '「裏道ルート」にたどり着けたのはさすがです。場所の特定に大きく近づきました。',
      hints: [
        '「これを大事に読んでほしい」という言葉は、祭事報告書の本文に何かしらの“仕掛け”が埋め込まれているサインかもしれません。その前後を意識して読んでみましょう。',
        '「『告白』を達成するまでの間」という表現は、少し引っかかる言い回しです。この“間”に、別の情報が隠されていると考えて読み直してみてはどうでしょう。',
        '祭事報告書の中で「告白」に関係する箇所の文字の“間”を、順番を意識しながら追ってみましょう。そこにメッセージが潜んでいるかもしれません。',
        '15ページは、佐久間の思いが特によく表れているページです。このページをキーとして、もう一度注意深く読み解いてみてください。',
        '中央付近の「告白」という言葉の文字間を連続して拾っていくと、「七月のちえくらべで宮巡行を辿り拾った文字読め」という指示文が浮かび上がってきます。その通りにたどってみましょう。',
        '「広報こだま」八月号に載っている前月のクロスワードの答えと、宮巡行のルートを重ねてみると、新しいヒントが見えてくるかもしれません。',
        'クロスワードの答えには「とりい／ごしんたい／いれいひ／ちょうずや」などが含まれています。これらを目印に宮巡行ルートをなぞり、対応する文字を一つずつ拾ってみてください。',
        '集めた文字を並べると、「きりかごきょうどかんみんぞくしだいはちろくきゅうごう」という形になります。これを資料名と号数として読み替えてみましょう。',
        '「霧籠郷土館民俗史第八六九号」を、デジタルアーカイブから実際に検索して内容を確かめてみてください。そこに次の手がかりが隠れているはずです。'
      ]
    }
  ];

  const map = buildMapFromSteps(steps);
  const summaryBuilder = (_ctx, _last) =>
    '整理すると、『篝森山の裏道ルート』が、行方不明者たちの足取りが途切れた場所' +
    'という結論になりますね。とても大切なポイントです。これで奇録会に送信してみますか？（送信 と入力）';

  const shortAnswer = '篝森山の裏道ルート';

  return { map, summaryBuilder, shortAnswer };
}

// Q4: 真相
function flowQ4() {
  const steps = [
    {
      prompt:
        'それでは、全体の真相を整理していきましょう。行方不明者がいなくなった山には、かつて何の製造施設がありましたか？',
      expect: '^毒ガス$',
      capture: 'facility',
      praise:
        'そういうことですか。確かに佐久間圭介が提供した供記に記載されていた内容から察するに、篝森山には毒ガスの製造施設がありました。',
      hints: [
        '供記は遠回しな表現が多く、製造施設の正体ははっきりとは書かれていません。気になる単語をいくつか抜き出して、外部情報（検索）と照らし合わせてみてはどうでしょう。',
        '「マスタード」や「独逸の学者」といった言葉は、特定の化学兵器に関する歴史的な文脈を示唆しています。関連する用語をネットで調べてみると、施設の性質が見えてくるかもしれません。'
      ]
    },
    {
      prompt:
        '仕様書の管理者名は消されていましたが、佐久間は別に手がかりを残していましたね。どの資料とどの資料から、管理者の名前が分かりましたか？（複数あれば「、」で区切ってください）',
      expect: '(?=.*広報こだま)(?=.*霧籠郷土館民俗史第八六九号)',
      capture: 'sources',
      praise:
        'その二つの資料をつなげて考えられているのが素晴らしいです。',
      hints: [
        'Q3で入手した資料は、佐久間のメッセージを読み解いた結果見つかった『編集後版』でした。編集前の状態では、どのような情報が残されていたのか、もう一度想像してみましょう。',
        'メッセージの復号に成功しているなら、その過程で参照した二つの資料のタイトルはすでに把握しているはずです。それらを組み合わせて考えてみてください。',
        'Q3で使った編集後の資料と見比べながら、「編集前の告白部分」にどんな違いがあるのか意識して読み返してみましょう。'
      ]
    },
    {
      prompt:
        'そこから読み取れた真犯人の名は、どのような形（表現）で示されていましたか？（漢字４文字で答えてください）',
      expect: '^地図記号$',
      capture: 'form',
      praise:
        '名前が「地図記号」で示されていたことまで押さえられているのは、とても鋭いですね。',
      hints: [
        '「霧籠郷土館民俗史第八六九号」を開いて、告白の部分の文字と文字の“間”を改めてたどってみてください。',
        'キーフレーズは「七月のちえくらべで宮巡行を辿り、ござ上に現れし記号」です。この指示に沿って、クロスワードのどのマスと、どのシンボルが対応しているのか探ってみましょう。',
        'クロスワードの該当マスを塗りつぶしていくと、ある形が視覚的に浮かび上がってきます。「記号」とは何を指すのか、八月のちえくらべなども手掛かりにしながら連想してみてください。',
        '「七月のちえくらべで宮巡行を辿り、ござ上に現れた記号」は、最終的に“地図記号”として理解することができます。対象のマスを塗りつぶして、その形を確認してみましょう。'
      ]
    },
    {
      prompt:
        'その毒ガス製造施設の管理者であり、真犯人といえる人物の名前を教えてください。',
      expect: '^竹林辰雄$',
      capture: 'culprit',
      praise: '見事な推理です。',
      hints: [
        '地図記号については、一覧表を検索して照合してみるのもよいですし、作中に登場した地図資料の中に同じ記号がないか探してみるのも有効です。その記号が指す人物をたどってみてください。'
      ]
    }
  ];

  const map = buildMapFromSteps(steps);
  const summaryBuilder = (_ctx, _last) =>
    'まとめると、『篝森山は旧毒ガス製造施設であり、その管理者で真犯人と考えられる人物は竹林辰雄である』' +
    'という結論になりますね。とても重い内容ですが、あなたの整理は確かだと思います。これで奇録会に送信してみますか？（送信 と入力）';

  const shortAnswer = '篝森山は旧毒ガス製造施設で、真犯人は竹林辰雄';

  return { map, summaryBuilder, shortAnswer };
}

// フロー一覧
function getFlows() {
  return {
    '行方不明者の根拠':     flowQ1(),
    '行方不明者の特徴':     flowQ2(),
    '行方不明になった場所': flowQ3(),
    '真相':                 flowQ4()
  };
}
