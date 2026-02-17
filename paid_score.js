function computePaidScore({ mode }) {
  if (mode === "CHAT") {
    return { enabled: false };
  }

  return {
    enabled: true,
    overall: 60,
    win: 55,
    safety: 60,
    clarity: 65,
    exec: 60,
    note: "悪くない。詰めれば上がる。",
  };
}

function formatPaidScoreForUser(score) {
  return `スコア ${score.overall}/100（勝ち筋:${score.win} 安全:${score.safety} 明確:${score.clarity} 実行:${score.exec}）
ひとこと：${score.note}`;
}

module.exports = { computePaidScore, formatPaidScoreForUser };
