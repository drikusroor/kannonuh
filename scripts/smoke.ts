/** Quick manual check: play a whole match bot-vs-bot and print what happened. */
import { Match } from '../src/server/match.ts';
import { botShop, planShot } from '../src/server/ai.ts';
import { cannonsOf, kingOf } from '../src/shared/world.ts';

const seed = Number(process.argv[2] ?? 1234);
const match = new Match({ seed, names: ['Redcoat', 'Bluecoat'], bots: [true, true] });

console.log('seed', seed, 'entities', match.world.entities.length, 'wind', match.world.wind);
console.log(
  'terrain range',
  Math.min(...match.world.terrain).toFixed(0),
  Math.max(...match.world.terrain).toFixed(0),
);

const t0 = performance.now();
let safety = 0;
while (match.state.phase === 'playing' && safety++ < 400) {
  const side = match.state.turn;
  botShop(match, side, 2);
  const plan = planShot(match, side, side === 0 ? 2 : 1);
  if (!plan) {
    match.endTurn();
    continue;
  }
  const out = match.fire(side, plan);
  if (out.error) {
    console.log('  error', out.error);
    match.endTurn();
    continue;
  }
  const r = out.result!;
  console.log(
    `T${match.state.turnNumber} P${side} ${r.ammo} el=${r.elevation.toFixed(0)} pw=${r.power.toFixed(0)} ` +
      `dmg=${r.damage} self=${r.selfDamage} cr=${r.credits} ticks=${r.ticks} dist=${r.distance} ` +
      `tracks=${r.tracks.length} events=${r.events.length}`,
  );
  if (match.state.shotsLeft <= 0 && match.state.phase === 'playing' && match.state.turn === side) {
    match.endTurn();
  }
  if (out.summary) {
    console.log('WINNER', out.summary.winner, 'in', out.summary.turns, 'turns');
    for (const s of out.summary.scores) {
      console.log(` P${s.side} ${s.name}: ${s.total} pts, acc ${(s.accuracy * 100).toFixed(0)}%`);
      for (const l of s.lines) console.log(`    ${l.label}: ${l.points} (${l.detail})`);
    }
  }
}

console.log('elapsed', (performance.now() - t0).toFixed(0), 'ms');
console.log('kings', kingOf(match.world, 0)?.hp ?? 'dead', kingOf(match.world, 1)?.hp ?? 'dead');
console.log('cannons', cannonsOf(match.world, 0).length, cannonsOf(match.world, 1).length);
console.log('phase', match.state.phase, 'turns', match.state.turnNumber);
