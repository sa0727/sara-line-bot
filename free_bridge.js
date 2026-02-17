// free_bridge.js

/**
 * 無料→有料ブリッジ制御
 * ・分析止まりか
 * ・戦略が必要か
 * を判定してトーンを変える
 */
function detectNeedStrategy({ answers }) {
  const a = answers || {};
  const cat = a.category || null;

  // ゴールが「行動」系なら戦略寄り
  const actionGoal = /会いたい|付き合いたい|告白|復縁|仲直り/.test(a.goal || "");

  // カテゴリ別：2スロットが揃ってる＝次は戦略（＝有料）
  const hasReplyCore = !!a.silence && !!a.goal;
  const hasExCore = !!a.breakupAgo && !!a.breakupReason;
  const hasConfessCore = !!a.meetCount && !!a.partnerTemp;
  const hasFightCore = !!a.contactStatus && !!a.fightGoal;

  if (cat === "REPLY" && hasReplyCore) return true;
  if (cat === "EX" && hasExCore) return true;
  if (cat === "CONFESS" && hasConfessCore) return true;
  if (cat === "FIGHT" && hasFightCore) return true;

  if (actionGoal) return true;

  return false;
}

function buildFreeToPaidBridge({ category, needStrategy }) {
  // 戦略が必要なときは強め誘導
  if (needStrategy) {
    return (
      "――\n" +
      "ここまでは“読み”。\n" +
      "ここからは“動き”。\n\n" +
      "動きは雑にやると一気に冷える。\n" +
      "勝ちにいくなら、有料で設計する💋"
    );
  }

  if (category === "EX") {
    return (
      "――\n" +
      "復縁は入口を間違えたら終わる。\n" +
      "直球はまだ危ない。\n\n" +
      "勝ち筋を組むなら、有料でやる💋"
    );
  }

  if (category === "REPLY") {
    return (
      "――\n" +
      "既読放置は温度管理ミスると詰む。\n" +
      "送るか待つかはタイミングで変わる。\n\n" +
      "ここからは有料で決める💋"
    );
  }

  if (category === "CONFESS") {
    return (
      "――\n" +
      "告白はタイミングが9割。\n" +
      "勢いでやると後悔する。\n\n" +
      "設計するなら有料💋"
    );
  }

  if (category === "FIGHT") {
    return (
      "――\n" +
      "謝り方ひとつで関係は逆転する。\n" +
      "ここ雑にやると取り返せない。\n\n" +
      "本気で戻すなら有料でいく💋"
    );
  }

  // その他
  return (
    "――\n" +
    "ここから先は“動き”。\n" +
    "中途半端にやると負ける。\n\n" +
    "勝ちたいなら、有料でいく💋"
  );
}

module.exports = {
  buildFreeToPaidBridge,
  detectNeedStrategy,
};


