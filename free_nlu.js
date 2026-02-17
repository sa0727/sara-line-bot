// free_nlu.js
// 無料NLU：
// - カテゴリ推定：REPLY | EX | CONFESS | FIGHT | OTHER
// - nextMissingQuestion() は { text, quickReplies, key } を返す
// - categoryが未確定でも、OTHER系の入力（同級生/サークル等）は拾って埋める（ループ防止）

function norm(s) {
  return (s || "").toString().trim();
}

function extractSilence(text) {
  const t = norm(text);
  if (!t) return null;

  const m = t.match(/(\d+)\s*(分|時間|日|週間|週|ヶ月|か月|月)/);
  if (m) return m[0];

  if (/数時間/.test(t)) return "数時間";
  if (/1日/.test(t)) return "1日";
  if (/2日/.test(t)) return "2日";
  if (/3日/.test(t)) return "3日以上";
  if (/1週間|一週間/.test(t)) return "1週間";
  if (/2週間/.test(t)) return "2週間";
  if (/1ヶ月|一ヶ月|1か月/.test(t)) return "1ヶ月";
  return null;
}

function extractMeetCount(text) {
  const t = norm(text);
  const m = t.match(/(\d+)\s*(回)/);
  if (m) return `${m[1]}回`;
  if (/初対面|まだ会ってない/.test(t)) return "0回";
  if (/0回/.test(t)) return "0回";
  if (/1回/.test(t)) return "1回";
  if (/2回/.test(t)) return "2回";
  if (/3回/.test(t)) return "3回以上";
  return null;
}

function extractBreakupAgo(text) {
  const t = norm(text);
  const m = t.match(/(\d+)\s*(日|週間|週|ヶ月|か月|月|年)/);
  if (m) return m[0];
  if (/最近/.test(t)) return "最近";
  if (/半年前/.test(t)) return "半年前";
  return null;
}

function inferCategory(text) {
  const t = norm(text);

  if (/(既読|未読|返信|返事|既読無視|未読無視|無視|ブロック|スタンプだけ)/.test(t)) return "REPLY";
  if (/(復縁|元カレ|元カノ|別れ|別れて|振られ|ふられ|距離置こ|別れた)/.test(t)) return "EX";
  if (/(喧嘩|けんか|気まず|怒らせ|揉め|言い合い|冷戦|ギクシャク)/.test(t)) return "FIGHT";

  // 誘い/距離詰め
  if (
    /(気になる子|気になる人|好きな人|片想い|片思い|誘いたい|誘う|遊びに|遊びたい|ご飯|ごはん|飲み|会いたい|会う約束|デート|LINE交換|連絡先|告白)/.test(
      t
    )
  ) {
    return "CONFESS";
  }

  if (/(恋愛|彼|彼女|好き|気になる)/.test(t)) return "OTHER";
  return null;
}

function looksLikeRelationshipStage(text) {
  const t = norm(text);
  // ボタン回答っぽい短文を優先で拾う
  if (/^(同級生|友達|サークル\/部活|サークル|部活|バイト\/職場|バイト|職場|その他)$/.test(t)) return true;
  return /(同級生|クラス|大学|サークル|部活|バイト|職場|友達|友人|知り合い)/.test(t);
}

function normalizeRelationshipStage(text) {
  const t = norm(text);
  if (t === "サークル/部活") return "サークル/部活";
  if (t === "バイト/職場") return "バイト/職場";
  return t.slice(0, 40);
}

function applyFreeNLU(text, answers) {
  const t = norm(text);
  const a = answers || {};
  const out = {};

  // ★まず、関係入力っぽいなら先に埋める（category未確定でも）
  if (looksLikeRelationshipStage(t) && !a.relationshipStage) {
    out.relationshipStage = normalizeRelationshipStage(t);
    // categoryが無いなら OTHER に寄せる（ループ防止）
    if (!a.category) out.category = "OTHER";
  }

  // category推定
  const cat = inferCategory(t);
  if (cat) out.category = cat;

  const effectiveCat = out.category || a.category;

  if (effectiveCat === "REPLY") {
    const sil = extractSilence(t);
    if (sil) out.silence = sil;

    if (/(会いたい|会う|会える)/.test(t)) out.goal = "会いたい";
    if (/(仲直り|仲なおり|謝り|誤解|修復)/.test(t)) out.goal = "仲直りしたい";
    if (/(付き合|告白|恋人)/.test(t)) out.goal = "付き合いたい";
    if (/(見極め|様子見|放置)/.test(t)) out.goal = "見極めたい";
  }

  if (effectiveCat === "EX") {
    const ago = extractBreakupAgo(t);
    if (ago) out.breakupAgo = ago;

    const m = t.match(/(理由|原因)[:：]\s*(.+)$/);
    if (m && m[2]) out.breakupReason = m[2].slice(0, 60);
    else if (/(浮気|他好き|冷め|価値観|ケンカ|喧嘩|忙しい|すれ違い)/.test(t)) out.breakupReason = t.slice(0, 60);
  }

  if (effectiveCat === "CONFESS") {
    const mc = extractMeetCount(t);
    if (mc) out.meetCount = mc;

    if (/(脈あり|いけそう|好意|ノリ良い|優しい|反応いい)/.test(t)) out.partnerTemp = "高め";
    if (/(普通|ふつう|友達|同期|よくわからない)/.test(t)) out.partnerTemp = "普通";
    if (/(そっけない|冷たい|反応薄い|避ける)/.test(t)) out.partnerTemp = "低め";

    if (/(誘いたい|遊びたい|ご飯|デート|会いたい)/.test(t)) out.goal = out.goal || "遊びに誘いたい";
    if (/(付き合|告白)/.test(t)) out.goal = out.goal || "付き合いたい";
  }

  if (effectiveCat === "FIGHT") {
    if (/(連絡(してない|取れてない)|未読|既読|ブロック|無視)/.test(t)) out.contactStatus = "途切れてる";
    if (/(少し|一応|たまに|普通に)/.test(t) && /(連絡|LINE|ライン)/.test(t)) out.contactStatus = "一応続いてる";

    if (/(謝り|謝罪|ごめん)/.test(t)) out.fightGoal = "謝って戻したい";
    if (/(話し合い|整理|落ち着い)/.test(t)) out.fightGoal = "落ち着いて話したい";
  }

  if (effectiveCat === "OTHER") {
    if (!out.relationshipStage && looksLikeRelationshipStage(t)) {
      out.relationshipStage = normalizeRelationshipStage(t);
    }

    if (/(誘いたい|遊びたい|ご飯|会いたい|デート)/.test(t)) out.goal = "遊びに誘いたい";
    if (/(距離|近づ|仲良く|もっと話|もっと知り|親しく|仲良くなり)/.test(t)) out.goal = "距離を縮めたい";
    if (/(付き合|告白)/.test(t)) out.goal = "付き合いたい";
    if (/(仲直り|修復)/.test(t)) out.goal = "仲直りしたい";
    if (/(見極め|様子見)/.test(t)) out.goal = "見極めたい";

    // OTHER入力が明確にCONFESS寄りなら持ち上げ
    const lift = inferCategory(t);
    if (lift === "CONFESS") out.category = "CONFESS";
  }

  return out;
}

function nextMissingQuestion(a) {
  const x = a || {};
  const cat = x.category || "OTHER";

  // REPLY
  if (cat === "REPLY") {
    if (!x.silence) {
      return {
        key: "reply_silence",
        text: "既読/返信なし、どれくらい？",
        quickReplies: ["数時間", "1日", "2〜3日", "1週間以上"],
      };
    }
    if (!x.goal) {
      return {
        key: "reply_goal",
        text: "ゴールはどれ？ 1つでいい💋",
        quickReplies: ["会いたい", "仲直りしたい", "付き合いたい", "見極めたい"],
      };
    }
    return null;
  }

  // EX
  if (cat === "EX") {
    if (!x.breakupAgo) {
      return {
        key: "ex_ago",
        text: "別れてからどれくらい？",
        quickReplies: ["1週間以内", "1ヶ月以内", "3ヶ月以内", "半年以上"],
      };
    }
    if (!x.breakupReason) {
      return {
        key: "ex_reason",
        text: "別れた理由、短く1行で書きなさい💋",
        quickReplies: ["価値観", "喧嘩", "他好き", "すれ違い", "わからない"],
      };
    }
    return null;
  }

  // CONFESS（誘い/距離詰め）
  if (cat === "CONFESS") {
    if (!x.meetCount) {
      return {
        key: "confess_meet",
        text: "その子と会った回数は？",
        quickReplies: ["0回", "1回", "2回", "3回以上"],
      };
    }
    if (!x.partnerTemp) {
      return {
        key: "confess_temp",
        text: "相手の温度感、どれが近い？",
        quickReplies: ["高め（脈あり寄り）", "普通", "低め（そっけない）", "わからない"],
      };
    }
    return null;
  }

  // FIGHT
  if (cat === "FIGHT") {
    if (!x.contactStatus) {
      return {
        key: "fight_contact",
        text: "いま連絡の状況は？",
        quickReplies: ["途切れてる", "一応続いてる", "ブロック気味", "わからない"],
      };
    }
    if (!x.fightGoal) {
      return {
        key: "fight_goal",
        text: "いちばんの希望はどれ？",
        quickReplies: ["謝って戻したい", "落ち着いて話したい", "距離を置きたい", "わからない"],
      };
    }
    return null;
  }

  // OTHER（無料は軽く）
  if (cat === "OTHER") {
    if (!x.relationshipStage) {
      return {
        key: "other_relation",
        text: "相手との関係は？（同級生/友達/サークル/バイト/職場）\n短く答えなさい💋",
        quickReplies: ["同級生", "友達", "サークル/部活", "バイト/職場", "その他"],
      };
    }
    if (!x.goal) {
      return {
        key: "other_goal",
        text: "いま一番したいことは？ 1つだけ💋",
        quickReplies: ["遊びに誘いたい", "距離を縮めたい", "告白したい", "様子を見たい"],
      };
    }
    return null;
  }

  return null;
}

module.exports = { applyFreeNLU, nextMissingQuestion };


