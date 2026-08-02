import { SCORE } from './constants.ts';
import { kingOf } from './world.ts';
import type { GameSummary, MatchState, PlayerScore, ScoreLine, Side } from './types.ts';

/**
 * Turns the raw match statistics into a scoreboard. Winning matters most, but a
 * fast, accurate siege is worth far more than a slow grind.
 */
export function summarise(match: MatchState, reason: GameSummary['reason']): GameSummary {
  const scores = ([0, 1] as Side[]).map((side) => scoreFor(match, side, reason)) as [
    PlayerScore,
    PlayerScore,
  ];
  return {
    winner: match.winner,
    reason,
    turns: match.turnNumber,
    durationMs: Math.max(0, (match.endedAt || Date.now()) - match.startedAt),
    scores,
  };
}

function scoreFor(match: MatchState, side: Side, reason: GameSummary['reason']): PlayerScore {
  const p = match.players[side];
  const s = p.stats;
  const lines: ScoreLine[] = [];
  const won = match.winner === side;
  const accuracy = s.shots > 0 ? s.hits / s.shots : 0;

  if (won) {
    lines.push({
      label: 'Victory',
      detail: reason === 'forfeit' ? 'opponent withdrew' : 'enemy king slain',
      points: SCORE.win,
    });
    const saved = Math.max(0, SCORE.parTurns - match.turnNumber);
    if (saved > 0) {
      lines.push({
        label: 'Swift siege',
        detail: `${saved} turn${saved === 1 ? '' : 's'} under par of ${SCORE.parTurns}`,
        points: saved * SCORE.perTurnSaved,
      });
    }
    const king = kingOf(match.world, side);
    if (king) {
      lines.push({
        label: 'King unharmed',
        detail: `${Math.round(king.hp)}/${king.maxHp} hit points remaining`,
        points: Math.round(king.hp * SCORE.survivingKingHp),
      });
    }
  }

  lines.push({
    label: 'Marksmanship',
    detail: `${s.hits}/${s.shots} shots on target (${Math.round(accuracy * 100)}%)`,
    points: Math.round(accuracy * SCORE.accuracyBonus),
  });
  lines.push({
    label: 'Damage dealt',
    detail: `${Math.round(s.damageDealt)} points of destruction`,
    points: Math.round(s.damageDealt * SCORE.damageDealt),
  });
  if (s.damageTaken > 0) {
    lines.push({
      label: 'Damage taken',
      detail: `${Math.round(s.damageTaken)} suffered`,
      points: Math.round(s.damageTaken * SCORE.damageTaken),
    });
  }
  if (s.cannonsKilled > 0) {
    lines.push({
      label: 'Guns silenced',
      detail: `${s.cannonsKilled} enemy cannon${s.cannonsKilled === 1 ? '' : 's'}`,
      points: s.cannonsKilled * SCORE.cannonKill,
    });
  }
  if (s.structuresKilled > 0) {
    lines.push({
      label: 'Masonry broken',
      detail: `${s.structuresKilled} block${s.structuresKilled === 1 ? '' : 's'} reduced to rubble`,
      points: s.structuresKilled * SCORE.structureKill,
    });
  }
  if (p.credits > 0) {
    lines.push({
      label: 'War chest',
      detail: `${p.credits} credits unspent`,
      points: Math.round(p.credits * SCORE.creditsLeft),
    });
  }

  const total = Math.max(0, lines.reduce((a, l) => a + l.points, 0));
  return { side, name: p.name, total, lines, stats: s, accuracy };
}

export function emptyStats() {
  return {
    shots: 0,
    hits: 0,
    damageDealt: 0,
    damageTaken: 0,
    cannonsKilled: 0,
    structuresKilled: 0,
    barrelsPopped: 0,
    bestHit: 0,
    kingHits: 0,
    creditsEarned: 0,
    creditsSpent: 0,
    longestShot: 0,
  };
}
