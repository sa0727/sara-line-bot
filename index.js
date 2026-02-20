// index.js
require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");

const { buildPaidContent } = require("./paid_templates");
const { generatePaidChatSara } = require("./paid_engine");
const { computePaidScore, formatPaidScoreForUser } = require("./paid_score");

// ★画像解析（vision_ocr.js）
const { analyzeImageToConsultText } = require("./vision_ocr");

// ★Stripe（月額課金）
const { mountStripeRoutes, getUser, isActiveUserRow } = require("./stripe_routes");

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { query } = require("./db");

/**
 * ✅ Health check（署名不要で「サーバ生存」確認）
 * - Render / Uptime / 手動テスト用
 */
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, at: new Date().toISOString() });
});

/**
 * Stripe Webhook は raw body が必要
 * - /stripe/checkout だけ JSON
 * - /stripe/webhook だけ raw
 * ※ line.middleware は独自に body を扱うので、app.use(express.json()) の全体適用は避ける
 */
app.jsonParser = express.json();
app.rawParser = express.raw({ type: "application/json" });

// Stripe routes（/stripe/checkout, /stripe/webhook, /billing/*）
mountStripeRoutes(app);

// ★DBテーブル自動作成（app.listenより前で1回だけ）
async function ensureTables() {
  try {
    await query(`
      create table if not exists users (
        line_user_id text primary key,
        stripe_customer_id text,
        stripe_subscription_id text,
        subscription_status text not null default 'inactive',
        current_period_end timestamptz,
        paid_until timestamptz,
        updated_at timestamptz not null default now()
      );
    `);

    await query(`
      create table if not exists payments (
        checkout_session_id text primary key,
        line_user_id text not null,
        stripe_subscription_id text,
        status text not null,
        created_at timestamptz not null default now()
      );
    `);

    await query(`
      create table if not exists processed_events (
        event_id text primary key,
        processed_at timestamptz not null default now()
      );
    `);

    console.log("✅ ensureTables OK (users/payments/processed_events)");
  } catch (e) {
    console.error("❌ ensureTables failed:", e);
  }
}

// ★listen前で必ず呼ぶ（awaitしない：起動ブロックしない）
ensureTables();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

const userStore = new Map();

function freshSession() {
  return {
    state: "FREE",
    answers: {},
    paid: {
      mode: "CHAT",
      phase: "UNKNOWN",
      history: [],
      lastScore: null,

      // 画像解析用
      lastImage: null,
      pendingImage: null, // { messageId, at }

      // 決済リンク連打抑止（任意）
      checkoutIssuedAt: null,
    },
  };
}

function getSession(userId) {
  if (!userStore.has(userId)) {
    userStore.set(userId, freshSession());
  }
  return userStore.get(userId);
}

function tidyLines(s) {
  return (s || "")
    .toString()
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function replyText(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: tidyLines(text),
  });
}

function isPaidButtonText(text) {
  const t = (text || "").trim();
  return (
    t === "▶ 続きを見る（有料）" ||
    t === "続きを見る（有料）" ||
    /続き.*有料/.test(t) ||
    (t.includes("▶") && t.includes("有料"))
  );
}

// LINE画像を dataURL に変換
async function fetchLineImageAsDataUrl(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buf = Buffer.concat(chunks);

  // PNG判定（簡易）
  const isPng =
    buf.length >= 8 &&
    buf
      .slice(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const mime = isPng ? "image/png" : "image/jpeg";

  return `data:${mime};base64,${buf.toString("base64")}`;
}

function isScreenshotPermissionText(text) {
  const t = (text || "").trim();
  return (
    /(スクショ|画像|LINE).*(送ってもいい|貼ってもいい|見せていい)/.test(t) ||
    /サラに.*(送ってもいい|貼ってもいい|見せていい)/.test(t)
  );
}

function shouldTriggerImageParse(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (/^(ok|OK|次|つぎ|続けて|続き|見て|みて|解析|お願い)$/.test(t)) return true;
  if (/(送った|貼った|送信|載せた|見てほしい)/.test(t)) return true;
  return true;
}

function dumpSession(session) {
  return {
    state: session.state,
    answers: session.answers,
    paid: {
      mode: session.paid?.mode,
      phase: session.paid?.phase,
      historyLen: session.paid?.history?.length || 0,
      lastScore: session.paid?.lastScore || null,
      lastImage: session.paid?.lastImage || null,
      pendingImage: session.paid?.pendingImage || null,
      checkoutIssuedAt: session.paid?.checkoutIssuedAt || null,
    },
  };
}

function isSmallTalkLike(text) {
  const t = (text || "").trim();
  if (!t) return true;
  if (
    /^(こんにちは|こんばんは|おはよ|おはよう|やあ|はじめまして|どうも|hi|hello)[！!。]*$/i.test(
      t
    )
  )
    return true;
  if (
    /^(うーん|んー|うん|はい|ok|OK|了解|りょ|わかった|わかりました|なるほど)[。!！]*$/i.test(
      t
    )
  )
    return true;
  return false;
}

function looksLikeRomance(text) {
  const t = (text || "").trim();
  if (!t) return false;
  return /(既読|未読|返信|LINE|連絡|告白|復縁|好き|気になる|彼氏|彼女|片思い|デート|会いたい|脈|距離|冷たい|別れ|元カレ|元カノ|付き合)/.test(
    t
  );
}

function pickMeaningfulLine(text) {
  const lines = tidyLines(text)
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";

  const noise =
    /^(うん|はい|ok|OK|了解|りょ|わかった|わかりました|なるほど|そう|そうそう|よし|とりあえず|一旦|すみません|ごめん)[。!！]*$/i;
  const meaningful = lines.filter((l) => !noise.test(l));

  if (meaningful.length > 0) return meaningful[meaningful.length - 1];
  return lines[lines.length - 1];
}

/**
 * 無料体験：軽い提案（案）
 * - 完成例文を量産しない
 * - “方向性/次の一手候補/NG/雛形1〜2” だけ
 */
function buildFreeLightAdvice(problem, goal) {
  const p = (problem || "").trim();
  const g = (goal || "").trim();

  const isReadIgnored = /(既読無視|未読無視|既読スルー|未読スルー|返信ない|返ってこない)/.test(p);
  const isReconcile = /(復縁|別れ|元カレ|元カノ)/.test(p) || /(復縁)/.test(g);
  const isConfess = /(告白|付き合)/.test(g) || /(告白|付き合)/.test(p);
  const isClose = /(距離|仲良く|近づ)/.test(g);

  let direction = "まずは相手の温度と前提（関係性/距離感）を揃えるのが勝ち筋♡";
  let doList = [
    "相手の反応が分かる材料を集める（直近のやり取り／相手の言い回し／既読未読）",
    "“返しやすい球”を1回だけ投げて様子見（質問は短く、重くしない）",
  ];
  let ngList = ["詰問（なんで返さないの？）", "長文連投／感情爆発／試す駆け引き"];

  let templates = [
    "「今ちょっとバタバタ？落ち着いたらでいいから、ひとことだけ返して〜🙂」",
    "「これだけ聞きたいんだけど、今週って忙しい？」",
  ];

  if (isReadIgnored) {
    direction = "既読無視は“追撃の質”で勝負が決まる。重くせず、返しやすく♡";
    doList = [
      "追撃は“1回だけ”にする（連投しない）",
      "質問は Yes/No か短文で返せる形にする",
      "24時間〜様子見して、相手の生活リズムを読む",
    ];
    templates = [
      "「今って忙しい？落ち着いたらでいいから、ひとことだけ返して🙂」",
      "「今日ふと思い出したんだけどさ、◯◯ってまだ好き？」",
    ];
    ngList = ["責める（なんで無視？）", "病む匂わせ／重い確認", "連投で圧をかける"];
  }

  if (isReconcile) {
    direction = "復縁は“感情”より“再接続の空気作り”が先。焦ると負けるわ💋";
    doList = [
      "いきなり関係を戻そうとしない（まず雑談レベルで再接続）",
      "相手が返しやすい“軽い近況”から入る",
      "反応が薄いなら深追いしない（撤退も勝ち筋）",
    ];
    templates = [
      "「久しぶり。ふと思い出しただけ。元気にしてた？」",
      "「近く通ったから思い出した。最近どう？」",
    ];
    ngList = ["謝罪長文", "いきなり復縁要求", "過去の蒸し返し"];
  }

  if (isConfess) {
    direction = "告白は“関係の土台”→“意思表示”の順。いきなり凸ると危ない♡";
    doList = [
      "相手の好意サイン（会話の濃さ/頻度/誘いへの反応）を1つ拾う",
      "次の接点（通話/一緒に遊ぶ/会う）を増やして温度を整える",
    ];
    templates = [
      "「今度、◯◯一緒にしよ。時間合う日ある？」",
      "「最近話すの楽しい。もうちょい一緒にいたいな」",
    ];
    ngList = ["雰囲気任せの突然告白", "返事を急かす", "重い覚悟語り"];
  }

  if (isClose && !isConfess) {
    direction = "距離を縮めるなら『頻度』より“安心感の一貫性”が強い♡";
    doList = [
      "相手が返しやすい“軽い共有＋短い質問”で接点を作る",
      "相手の生活リズムに合わせて、無理に追わない",
    ];
    templates = [
      "「今日ちょっと笑った話ある。時間ある時に聞いてw」",
      "「今度また一緒にやろ。次は◯◯試したい」",
    ];
    ngList = ["反応に一喜一憂して態度がブレる", "駆け引きで試す"];
  }

  return [
    "【軽い提案（案）】",
    `・方向性：${direction}`,
    `・まずやること：${doList.map((x) => `\n  - ${x}`).join("")}`,
    `・NG：${ngList.map((x) => `\n  - ${x}`).join("")}`,
    "",
    "【雛形（まだ“完成設計”じゃない）】💋",
    `- ${templates[0]}`,
    `- ${templates[1]}`,
  ].join("\n");
}

/**
 * ✅ /webhook
 * - line.middleware より前にロガーを入れる（到達可視化）
 * - 署名がない手動POSTはここで分かる
 */
app.post(
  "/webhook",
  (req, res, next) => {
    console.log("🔥 /webhook HIT", new Date().toISOString());
    console.log("has x-line-signature:", !!req.headers["x-line-signature"]);
    next();
  },
  line.middleware(config),
  (req, res) => {
    // ✅ 先に200を返す（超重要）
    res.status(200).end();

    // ✅ あとで非同期処理
    Promise.all((req.body.events || []).map(handleEvent))
      .then(() => {
        console.log("✅ webhook async complete");
      })
      .catch((err) => {
        console.error("❌ webhook async error:", err);
      });
  }
);

async function handleEvent(event) {
  if (!event || event.type !== "message") return null;

  const userId = event.source?.userId;

  console.log("===== LINE EVENT DEBUG =====");
  console.log("LINE USER ID:", userId);
  console.log("EVENT TYPE:", event.type);
  console.log("============================");

  if (!userId) return null;

  const session = getSession(userId);

  // ★課金状態：DBが真実
  try {
    const u = await getUser(userId);
    if (isActiveUserRow(u)) {
      session.state = "PAID_CHAT";
    } else {
      if (session.state === "PAID_CHAT") session.state = "PAID_GATE";
    }
  } catch (e) {
    console.error("[PAID_CHECK] failed", e);
  }

  // 画像メッセージ：即返信＋キュー保存
  if (event.message?.type === "image") {
    try {
      session.paid.pendingImage = { messageId: event.message.id, at: Date.now() };

      return replyText(
        event,
        `受け取った💋
いまのスクショ、次のメッセージで読み取るわ。

「OK」って送って。
（個人情報は隠していい）`
      );
    } catch (e) {
      console.error("[IMAGE] enqueue failed:", e);
      return replyText(
        event,
        `画像は受け取ったけど、今ちょっと詰まった💋
もう一回送るか、内容をテキストで1〜3行で貼って。`
      );
    }
  }

  // テキスト以外（スタンプ等）は無視
  if (event.message?.type !== "text") return null;

  let text = (event.message.text || "").trim();

  // #dump
  if (text === "#dump") {
    return replyText(
      event,
      "```json\n" + JSON.stringify(dumpSession(session), null, 2) + "\n```"
    );
  }

  // リセット
  if (text === "リセット") {
    userStore.delete(userId);
    return replyText(
      event,
      `いらっしゃい💋 サラよ。
ここは恋愛の勝ち筋を作る場所。
状況をそのまま書きなさい。`
    );
  }

  // 🔴 スクショ送付確認は即レス（AI呼ばない）
  if (isScreenshotPermissionText(text)) {
    return replyText(
      event,
      `送って💋
トークスクショでも文章でもOK。
個人情報は隠していいわよ。`
    );
  }

  // ★pendingImage があれば、先に解析してテキスト合流
  if (session?.paid?.pendingImage && shouldTriggerImageParse(text)) {
    const pending = session.paid.pendingImage;
    session.paid.pendingImage = null;

    try {
      const dataUrl = await fetchLineImageAsDataUrl(pending.messageId);

      const vision = await analyzeImageToConsultText({
        openai,
        dataUrl,
        hintText: "LINEのトークスクショ。恋愛相談として必要な要点を抜き出して。",
      });

      session.paid.lastImage = {
        kind: vision.kind,
        summary: vision.summary || null,
        userIntent: vision.userIntent || null,
        extractedLinesCount: Array.isArray(vision.extractedLines)
          ? vision.extractedLines.length
          : 0,
        missingQuestions: Array.isArray(vision.missingQuestions)
          ? vision.missingQuestions
          : [],
        at: new Date().toISOString(),
      };

      const synthetic =
        vision.suggestedUserText ||
        tidyLines(
          `（トークスクショ要約）\n${
            vision.summary || "要約が取れなかった"
          }\n\n相談：この状況で次の一手を考えて。`
        );

      text = tidyLines(`${synthetic}\n\n（補足）${text}`);
    } catch (e) {
      console.error("[IMAGE] analyze failed:", e);
      return replyText(
        event,
        `画像は受け取った。
でも今ちょっと読み取りに失敗したわ💋

スクショの内容を、テキストで1〜3行で貼って。どこが気になる？`
      );
    }
  }

  // --------------------------
  // 無料フェーズ（雑談を恋愛に戻す＋軽い提案を必ず出す）
  // --------------------------
  if (session.state === "FREE") {
    // 1) まだ problem がない時：雑談なら恋愛に戻す
    if (!session.answers.problem) {
      if (isSmallTalkLike(text) || !looksLikeRomance(text)) {
        return replyText(
          event,
          `ここは恋愛の話だけね💋
挨拶は受け取った。

いまの恋の状況を1〜2行で。
（例：オンラインの子が気になる／既読無視／復縁したい など）`
        );
      }

      session.answers.problem = pickMeaningfulLine(text);
      return replyText(
        event,
        `うん。
いま一番したいことは？（告白/復縁/距離縮めたい など）`
      );
    }

    // 2) goal 未設定
    if (!session.answers.goal) {
      if (isSmallTalkLike(text) || text.length <= 1) {
        return replyText(
          event,
          `目的を決めるわ💋
いま一番したいことはどれ？

・距離を縮めたい
・既読無視を解決したい
・告白したい
・復縁したい
・仲直りしたい

この中で一番近いのを1つでいい。`
        );
      }

      session.answers.goal = pickMeaningfulLine(text);

      // ✅ FREEの締め：軽い提案（案）を出してから、有料導線（= PAID_GATE）
      session.state = "PAID_GATE";

      const advice = buildFreeLightAdvice(session.answers.problem, session.answers.goal);

      return replyText(
        event,
        `状況は整理できたわ💋

・いまの状況：${session.answers.problem}
・狙い：${session.answers.goal}

${advice}

――
ここから先は“設計”になる。
勝ちたいなら、有料でいく💋

（有料に進むなら「▶ 続きを見る（有料）」って送って）`
      );
    }
  }

  // --------------------------
  // 有料ゲート：Checkoutリンクを出す（PAID解放はWebhookで確定）
  // --------------------------
  if (session.state === "PAID_GATE" && isPaidButtonText(text)) {
    // すでに課金済みなら即入れる（保険）
    try {
      const u = await getUser(userId);
      if (isActiveUserRow(u)) {
        session.state = "PAID_CHAT";
        return replyText(event, buildPaidContent(session.answers));
      }
    } catch {}

    // 連打でリンク大量発行を抑える（60秒）
    if (
      session.paid.checkoutIssuedAt &&
      Date.now() - session.paid.checkoutIssuedAt < 60 * 1000
    ) {
      return replyText(
        event,
        `いま決済リンク作ってる最中💋
1分だけ待てる？
（待てないならもう一回送ってもいいけど、リンクが増えるだけよ）`
      );
    }
    session.paid.checkoutIssuedAt = Date.now();

    const baseUrl = process.env.APP_BASE_URL;

    try {
      if (typeof fetch !== "function") {
        throw new Error("fetch is not available. Use Node 18+ or install node-fetch.");
      }

      const r = await fetch(`${baseUrl}/stripe/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineUserId: userId }),
      });
      const j = await r.json();

      if (j.alreadyPaid) {
        session.state = "PAID_CHAT";
        return replyText(event, buildPaidContent(session.answers));
      }

      if (!j.url) throw new Error("missing checkout url");

      return replyText(
        event,
        `ここからは設計モード💋
月額¥980、縛りなし。いつでも解約できる。

▶ 決済して続ける：${j.url}

決済が完了したら、そのままLINEで続けな。`
      );
    } catch (e) {
      console.error("[PAYWALL] checkout failed", e);
      return replyText(
        event,
        `今、決済リンクの発行で詰まった💋
もう一回「▶ 続きを見る（有料）」って送って。`
      );
    }
  }

  // --------------------------
  // 有料チャット
  // --------------------------
  if (session.state === "PAID_CHAT") {
    const aiReply = await generatePaidChatSara({
      openai,
      answers: session.answers,
      history: session.paid.history,
      userText: text,
    });

    session.paid.history.push({ role: "user", content: text });
    session.paid.history.push({ role: "assistant", content: aiReply });

    const score = computePaidScore({
      userText: text,
      mode: session.paid.mode,
      phase: session.paid.phase,
      answers: session.answers,
    });

    let finalReply = aiReply;

    // mode=CHAT は保存もしない（paid_score.js 側でも弾くが保険）
    if (score && score.enabled && !/CHAT/i.test(String(session.paid.mode || ""))) {
      session.paid.lastScore = score;
      finalReply += `\n\n――\n${formatPaidScoreForUser(score)}`;
    } else {
      session.paid.lastScore = null;
    }

    return replyText(event, finalReply);
  }

  return replyText(event, "うまく読めなかったわ💋 もう一回。");
}

const PORT = process.env.PORT || 3000;

/**
 * ✅ Express エラーハンドラ
 * - line.middleware 署名エラー等をログに出して 500 を潰す
 * ※ ルート定義の後・listen の前に置く
 */
app.use((err, req, res, next) => {
  console.error("❌ express error:", err);
  res.status(400).send("bad request");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});