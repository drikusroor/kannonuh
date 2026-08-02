import {
  AMMO,
  AMMO_ORDER,
  BUILDS,
  BUILD_ORDER,
  CANNONS,
  CANNON_ORDER,
  UPGRADES,
  UPGRADE_ORDER,
  type AmmoId,
  type BuildId,
  type CannonId,
  type UpgradeId,
} from '../shared/constants.ts';
import { ammoPrice, cannonPrice, upgradePrice } from '../shared/shop.ts';
import type { Entity, GameSummary, MatchSnapshot, RoomInfo, Side } from '../shared/types.ts';

export interface UiHooks {
  practice(difficulty: number): void;
  create(): void;
  quick(): void;
  join(code: string): void;
  ready(value: boolean): void;
  leave(): void;
  selectGun(id: number): void;
  aim(elevation: number, power: number): void;
  chooseAmmo(ammo: AmmoId): void;
  fire(): void;
  endTurn(): void;
  buyAmmo(ammo: AmmoId): void;
  buyCannon(cannon: CannonId): void;
  buyUpgrade(cannonId: number, upgrade: UpgradeId): void;
  build(build: BuildId): void;
  cancelPlacing(): void;
  chat(text: string): void;
  emote(icon: string): void;
  rematch(): void;
  resign(): void;
  toggleSound(): boolean;
  toggleMusic(): boolean;
  fit(): void;
  nameChanged(name: string): void;
}

export interface ViewModel {
  state: MatchSnapshot | null;
  you: Side | -1;
  selected: number;
  aim: { elevation: number; power: number; ammo: AmmoId };
  busy: boolean;
}

const EMOTES = ['👋', '😂', '😮', '🔥', '💀', '🎩', '🍻', '🤝', '😤', '🫡', '🎯', '🐌'];

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export class Ui {
  hooks: UiHooks;
  private difficulty = 1;
  private shopTab = 'ammo';
  private lastKingHp: [number, number] = [0, 0];
  private lastVm: ViewModel | null = null;
  private toastTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(hooks: UiHooks) {
    this.hooks = hooks;
    this.bind();
  }

  // ------------------------------------------------------------------ setup

  private bind(): void {
    const nameInput = $<HTMLInputElement>('name-input');
    nameInput.value = localStorage.getItem('kannonuh.name') ?? '';
    nameInput.addEventListener('change', () => {
      localStorage.setItem('kannonuh.name', nameInput.value.trim());
      this.hooks.nameChanged(nameInput.value.trim());
    });

    $('menu-practice').onclick = () => this.hooks.practice(this.difficulty);
    $('menu-create').onclick = () => this.hooks.create();
    $('menu-quick').onclick = () => this.hooks.quick();
    $<HTMLFormElement>('join-form').onsubmit = (e) => {
      e.preventDefault();
      const code = $<HTMLInputElement>('join-code').value.trim().toUpperCase();
      if (code) this.hooks.join(code);
    };
    for (const btn of Array.from($('difficulty').querySelectorAll<HTMLButtonElement>('button[data-diff]'))) {
      btn.onclick = () => {
        this.difficulty = Number(btn.dataset.diff);
        for (const b of Array.from($('difficulty').querySelectorAll('button'))) b.classList.remove('active');
        btn.classList.add('active');
      };
    }

    $('lobby-ready').onclick = () => {
      const btn = $('lobby-ready');
      const next = btn.textContent !== 'Stand down';
      this.hooks.ready(next);
    };
    $('lobby-leave').onclick = () => this.hooks.leave();
    $('copy-code').onclick = async () => {
      const code = $('lobby-code').textContent ?? '';
      try {
        await navigator.clipboard.writeText(code);
        this.toast('good', 'Code copied');
      } catch {
        this.toast('info', `Code: ${code}`);
      }
    };

    $('fire-btn').onclick = () => this.hooks.fire();
    $('endturn-btn').onclick = () => this.hooks.endTurn();
    $('shop-btn').onclick = () => this.openShop();
    $('placing-cancel').onclick = () => this.hooks.cancelPlacing();

    const elev = $<HTMLInputElement>('elev-slider');
    const power = $<HTMLInputElement>('power-slider');
    const push = () => this.hooks.aim(Number(elev.value), Number(power.value));
    elev.oninput = push;
    power.oninput = push;
    for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-nudge]'))) {
      btn.onclick = () => {
        const delta = Number(btn.dataset.delta);
        if (btn.dataset.nudge === 'elev') elev.value = String(Number(elev.value) + delta);
        else power.value = String(Number(power.value) + delta);
        push();
      };
    }

    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-close]'))) {
      el.onclick = () => $(el.dataset.close!).classList.add('hidden');
    }
    for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'))) {
      tab.onclick = () => {
        this.shopTab = tab.dataset.tab!;
        for (const t of Array.from(document.querySelectorAll('.tab'))) t.classList.remove('active');
        tab.classList.add('active');
        for (const body of ['ammo', 'cannons', 'upgrades', 'build']) {
          $(`tab-${body}`).classList.toggle('hidden', body !== this.shopTab);
        }
      };
    }

    $('chat-btn').onclick = () => {
      const chat = $('chat');
      chat.classList.toggle('hidden');
      if (!chat.classList.contains('hidden')) $<HTMLInputElement>('chat-input').focus();
    };
    $<HTMLFormElement>('chat-form').onsubmit = (e) => {
      e.preventDefault();
      const input = $<HTMLInputElement>('chat-input');
      const text = input.value.trim();
      if (text) this.hooks.chat(text);
      input.value = '';
      input.blur();
    };

    const picker = $('emote-picker');
    picker.innerHTML = '';
    for (const icon of EMOTES) {
      const b = document.createElement('button');
      b.textContent = icon;
      b.onclick = () => {
        this.hooks.emote(icon);
        picker.classList.add('hidden');
      };
      picker.appendChild(b);
    }
    $('emote-btn').onclick = () => picker.classList.toggle('hidden');

    $('sound-btn').onclick = () => {
      const on = this.hooks.toggleSound();
      $('sound-btn').classList.toggle('off', !on);
      $('sound-btn').textContent = on ? '🔊' : '🔇';
    };
    $('music-btn').onclick = () => {
      const on = this.hooks.toggleMusic();
      $('music-btn').classList.toggle('off', !on);
    };
    $('zoom-btn').onclick = () => this.hooks.fit();
    $('resign-btn').onclick = () => {
      if (confirm('Strike the colours and hand your opponent the win?')) this.hooks.resign();
    };
    $('help-btn').onclick = () => $('help').classList.remove('hidden');

    $('over-rematch').onclick = () => this.hooks.rematch();
    $('over-leave').onclick = () => this.hooks.leave();
  }

  get playerName(): string {
    return $<HTMLInputElement>('name-input').value.trim();
  }

  // ------------------------------------------------------------------ views

  showMenu(): void {
    $('menu').classList.remove('hidden');
    $('lobby').classList.add('hidden');
    $('over').classList.add('hidden');
    $('hud').classList.add('hidden');
    $('shop').classList.add('hidden');
  }

  showLobby(info: RoomInfo, you: Side | -1): void {
    $('menu').classList.add('hidden');
    $('over').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    $('lobby-code').textContent = info.code;
    const seats = $('lobby-seats');
    seats.innerHTML = '';
    for (const p of info.players) {
      const div = document.createElement('div');
      div.className = `seat s${p.side}${p.ready ? ' ready' : ''}`;
      const who = p.bot ? `${p.name || 'Gunnery master'} (bot)` : p.name || 'Empty seat';
      div.innerHTML = `<span>${escapeHtml(who)}${p.side === you ? ' <em>(you)</em>' : ''}</span><span class="status">${
        p.bot ? 'ready' : p.connected ? (p.ready ? 'ready' : 'preparing…') : 'waiting'
      }</span>`;
      seats.appendChild(div);
    }
    const me = info.players.find((p) => p.side === you);
    $('lobby-ready').textContent = me?.ready ? 'Stand down' : 'I am ready';
    $('lobby-hint').textContent =
      info.players.filter((p) => p.connected).length < 2
        ? 'Share the battle code with your opponent.'
        : 'Both gunners must be ready to begin.';
  }

  showHud(): void {
    $('menu').classList.add('hidden');
    $('lobby').classList.add('hidden');
    $('over').classList.add('hidden');
    $('hud').classList.remove('hidden');
  }

  // -------------------------------------------------------------------- hud

  update(vm: ViewModel): void {
    this.lastVm = vm;
    const state = vm.state;
    if (!state) return;
    const yours = vm.you !== -1 && state.turn === vm.you && state.phase === 'playing';

    for (const side of [0, 1] as Side[]) {
      const p = state.players[side];
      const el = $(`team-${side}`);
      el.querySelector('[data-name]')!.textContent = p.name;
      const king = state.world.entities.find((e) => e.kind === 'king' && e.owner === side);
      const hp = king ? Math.max(0, Math.round(king.hp)) : 0;
      const max = king ? king.maxHp : 320;
      const bar = el.querySelector<HTMLElement>('[data-king]')!;
      bar.style.setProperty('--pct', `${(hp / max) * 100}%`);
      el.querySelector('[data-kinghp]')!.textContent = String(hp);
      if (hp < this.lastKingHp[side]) {
        const box = bar.parentElement!;
        box.classList.add('hurt');
        setTimeout(() => box.classList.remove('hurt'), 950);
      }
      this.lastKingHp[side] = hp;
      el.querySelector('[data-credits]')!.textContent = String(Math.round(p.credits));
      el.querySelector('[data-guns]')!.textContent = String(
        state.world.entities.filter((e) => e.kind === 'cannon' && e.owner === side).length,
      );
    }

    const label = $('turn-label');
    if (state.phase === 'over') label.textContent = 'Battle over';
    else if (vm.you === -1) label.textContent = `${state.players[state.turn].name} to fire`;
    else label.textContent = yours ? 'Your volley' : `${state.players[state.turn].name} is aiming…`;
    label.style.color = state.turn === 0 ? 'var(--red)' : 'var(--blue)';

    const shots = $('shots-left');
    shots.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      if (i < state.shotsLeft) dot.className = 'live';
      shots.appendChild(dot);
    }

    const wind = state.world.wind;
    const needle = $('wind-needle');
    const pct = Math.abs(wind) * 50;
    needle.style.width = `${pct}%`;
    needle.style.left = wind >= 0 ? '50%' : `${50 - pct}%`;
    needle.style.background = Math.abs(wind) > 0.6 ? 'var(--red)' : 'var(--brass)';
    $('wind-value').textContent =
      Math.abs(wind) < 0.06 ? 'calm' : `${wind > 0 ? '▶' : '◀'} ${Math.abs(wind).toFixed(2)}`;

    this.renderGuns(vm);
    this.renderAmmo(vm);

    const canFire = yours && !vm.busy && state.shotsLeft > 0;
    $<HTMLButtonElement>('fire-btn').disabled = !canFire;
    $<HTMLButtonElement>('endturn-btn').disabled = !yours || vm.busy;
    $<HTMLButtonElement>('shop-btn').disabled = !yours || vm.busy;

    $('elev-value').textContent = `${vm.aim.elevation.toFixed(1)}°`;
    $('power-value').textContent = String(Math.round(vm.aim.power));
    $<HTMLInputElement>('elev-slider').value = String(vm.aim.elevation);
    $<HTMLInputElement>('power-slider').value = String(vm.aim.power);
    $('power-fill').style.width = `${vm.aim.power}%`;

    if (!$('shop').classList.contains('hidden')) this.renderShop(vm);
  }

  clock(deadline: number, phase: string): void {
    const el = $('turn-clock');
    if (phase !== 'playing') {
      el.textContent = '';
      return;
    }
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const m = Math.floor(left / 60);
    const s = left % 60;
    el.textContent = `${m}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('urgent', left <= 15);
  }

  private renderGuns(vm: ViewModel): void {
    const list = $('gun-list');
    const state = vm.state!;
    const mine = state.world.entities.filter((e) => e.kind === 'cannon' && e.owner === vm.you);
    list.innerHTML = '';
    for (const gun of mine) {
      const def = CANNONS[gun.cannon ?? 'field'];
      const div = document.createElement('div');
      div.className = `gun${gun.id === vm.selected ? ' active' : ''}${gun.firedThisTurn ? ' spent' : ''}`;
      const ups = Object.entries(gun.upgrades ?? {})
        .filter(([, lvl]) => (lvl as number) > 0)
        .map(([k, lvl]) => `${UPGRADES[k as UpgradeId].icon}${lvl}`)
        .join(' ');
      div.innerHTML = `
        <span>${def.id === 'mortar' ? '🧨' : def.id === 'longgun' ? '🔭' : '💥'}</span>
        <span>
          <div>${def.name}</div>
          <div class="hp"><i style="width:${(gun.hp / gun.maxHp) * 100}%"></i></div>
        </span>
        <span class="tag">${gun.firedThisTurn ? 'spent' : ups || 'ready'}</span>`;
      div.onclick = () => this.hooks.selectGun(gun.id);
      list.appendChild(div);
    }
    if (mine.length === 0) {
      list.innerHTML = '<div class="tag">No guns — a militia piece arrives next turn.</div>';
    }
  }

  private renderAmmo(vm: ViewModel): void {
    const list = $('ammo-list');
    const player = vm.you === -1 ? null : vm.state!.players[vm.you];
    list.innerHTML = '';
    for (const id of AMMO_ORDER) {
      const def = AMMO[id];
      const count = def.cost === 0 ? Infinity : player?.ammo[id] ?? 0;
      const chip = document.createElement('button');
      chip.className = `ammo-chip${vm.aim.ammo === id ? ' active' : ''}${count <= 0 ? ' empty' : ''}`;
      chip.title = `${def.name} — ${def.blurb}`;
      chip.innerHTML = `<span>${def.icon}</span><span>${def.name.split(' ')[0]}</span><b>${
        count === Infinity ? '∞' : count
      }</b>`;
      chip.onclick = () => this.hooks.chooseAmmo(id);
      list.appendChild(chip);
    }
  }

  // ------------------------------------------------------------------- shop

  openShop(): void {
    $('shop').classList.remove('hidden');
    if (this.lastVm) this.renderShop(this.lastVm);
  }

  closeShop(): void {
    $('shop').classList.add('hidden');
  }

  renderShop(vm: ViewModel): void {
    const state = vm.state;
    if (!state || vm.you === -1) return;
    const player = state.players[vm.you];
    $('shop-credits').textContent = String(Math.round(player.credits));
    const yourTurn = state.turn === vm.you && state.phase === 'playing';
    $('shop-hint').textContent = yourTurn
      ? 'Placed structures drop onto the ground where you click.'
      : 'You can only requisition on your own turn.';

    // Ammunition
    const ammoBody = $('tab-ammo');
    ammoBody.innerHTML = '';
    for (const id of AMMO_ORDER) {
      const def = AMMO[id];
      if (def.cost === 0) continue;
      const { price, count } = ammoPrice(id);
      ammoBody.appendChild(
        this.item(def.icon, def.name, def.blurb, `blast ${def.blast || '—'} · dmg ${def.impact + def.blastDamage}`, {
          label: `${price} ⛃ ×${count}`,
          disabled: !yourTurn || player.credits < price,
          onClick: () => this.hooks.buyAmmo(id),
        }),
      );
    }

    // Ordnance
    const cannonBody = $('tab-cannons');
    cannonBody.innerHTML = '';
    const owned = state.world.entities.filter((e) => e.kind === 'cannon' && e.owner === vm.you);
    for (const id of CANNON_ORDER) {
      const def = CANNONS[id];
      const price = cannonPrice(id, owned.filter((c) => c.cannon === id).length);
      cannonBody.appendChild(
        this.item(
          '🎯',
          def.name,
          def.blurb,
          `hp ${def.hp} · velocity ×${def.speed} · scatter ${def.spread}°`,
          {
            label: `${price} ⛃`,
            disabled: !yourTurn || player.credits < price || owned.length >= 5,
            onClick: () => this.hooks.buyCannon(id),
          },
        ),
      );
    }

    // Upgrades — one card per gun.
    const upBody = $('tab-upgrades');
    upBody.innerHTML = '';
    if (owned.length === 0) upBody.innerHTML = '<p class="hint">You have no guns to improve.</p>';
    for (const gun of owned) {
      const head = document.createElement('h5');
      head.textContent = `${CANNONS[gun.cannon ?? 'field'].name} · ${Math.round(gun.hp)}/${gun.maxHp} hp`;
      head.style.margin = '6px 0 0';
      upBody.appendChild(head);
      for (const uid of UPGRADE_ORDER) {
        const def = UPGRADES[uid];
        const level = gun.upgrades?.[uid] ?? 0;
        const price = upgradePrice(uid, level);
        const maxed = level >= def.maxLevel;
        upBody.appendChild(
          this.item(def.icon, `${def.name} ${'★'.repeat(level)}`, def.blurb, `level ${level}/${def.maxLevel}`, {
            label: maxed ? 'maxed' : `${price} ⛃`,
            disabled: !yourTurn || maxed || player.credits < price,
            onClick: () => this.hooks.buyUpgrade(gun.id, uid),
          }),
        );
      }
    }

    // Fortifications
    const buildBody = $('tab-build');
    buildBody.innerHTML = '';
    for (const id of BUILD_ORDER) {
      const def = BUILDS[id];
      buildBody.appendChild(
        this.item(def.icon, def.name, def.blurb, '', {
          label: `${def.cost} ⛃`,
          disabled: !yourTurn || player.credits < def.cost,
          onClick: () => this.hooks.build(id),
        }),
      );
    }
  }

  private item(
    icon: string,
    title: string,
    blurb: string,
    stat: string,
    action: { label: string; disabled: boolean; onClick: () => void },
  ): HTMLElement {
    const div = document.createElement('div');
    div.className = 'shop-item';
    div.innerHTML = `<div class="icon">${icon}</div>
      <div><h5>${escapeHtml(title)}</h5><p>${escapeHtml(blurb)}</p>${
        stat ? `<div class="stat">${escapeHtml(stat)}</div>` : ''
      }</div>`;
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.disabled = action.disabled;
    btn.onclick = action.onClick;
    div.appendChild(btn);
    return div;
  }

  // ---------------------------------------------------------------- placing

  showPlacing(label: string): void {
    $('placing-label').textContent = label;
    $('placing').classList.remove('hidden');
  }

  hidePlacing(): void {
    $('placing').classList.add('hidden');
  }

  // --------------------------------------------------------------- messages

  toast(kind: 'info' | 'warn' | 'good', text: string): void {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    box.appendChild(el);
    const t = setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 400);
      this.toastTimers.delete(t);
    }, 3200);
    this.toastTimers.add(t);
    while (box.children.length > 4) box.firstChild?.remove();
  }

  banner(text: string, ms = 1600): void {
    const el = $('banner');
    el.classList.remove('hidden');
    el.querySelector('span')!.textContent = text;
    const span = el.querySelector('span')!;
    span.style.animation = 'none';
    void span.offsetWidth;
    span.style.animation = '';
    setTimeout(() => el.classList.add('hidden'), ms);
  }

  chatLine(from: string, side: Side | -1, text: string): void {
    const log = $('chat-log');
    const div = document.createElement('div');
    div.className = `s${side}`;
    div.innerHTML = `<span class="who">${escapeHtml(from)}</span>: ${escapeHtml(text)}`;
    log.appendChild(div);
    while (log.children.length > 60) log.firstChild?.remove();
    log.scrollTop = log.scrollHeight;
    if ($('chat').classList.contains('hidden')) this.toast('info', `${from}: ${text}`);
  }

  emotePop(icon: string, x: number, y: number): void {
    const el = document.createElement('div');
    el.className = 'emote-pop';
    el.textContent = icon;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    $('emote-layer').appendChild(el);
    setTimeout(() => el.remove(), 2000);
  }

  connection(up: boolean): void {
    $('connection').classList.toggle('hidden', up);
  }

  // ------------------------------------------------------------ after action

  showOver(summary: GameSummary, you: Side | -1, entities: Entity[]): void {
    $('over').classList.remove('hidden');
    const won = summary.winner === you;
    const title = $('over-title');
    if (you === -1) {
      title.textContent = summary.winner === -1 ? 'Stalemate' : `${summary.scores[summary.winner].name} wins`;
    } else {
      title.textContent = summary.winner === -1 ? 'Stalemate' : won ? 'Victory!' : 'Defeat';
    }
    title.style.color = won ? 'var(--brass)' : summary.winner === -1 ? '' : 'var(--red)';
    const mins = Math.floor(summary.durationMs / 60000);
    const secs = Math.floor((summary.durationMs % 60000) / 1000);
    $('over-sub').textContent = `${
      summary.reason === 'forfeit' ? 'The field was abandoned' : 'The king has fallen'
    } · ${summary.turns} turns · ${mins}m ${String(secs).padStart(2, '0')}s`;

    const scores = $('over-scores');
    scores.innerHTML = '';
    for (const s of summary.scores) {
      const card = document.createElement('div');
      card.className = `score-card${summary.winner === s.side ? ' win' : ''}`;
      card.innerHTML =
        `<h3 style="color:${s.side === 0 ? 'var(--red)' : 'var(--blue)'}">${escapeHtml(s.name)}</h3>` +
        `<div class="total">${s.total}</div>` +
        s.lines
          .map(
            (l) =>
              `<div class="score-line"><span>${escapeHtml(l.label)}<em>${escapeHtml(l.detail)}</em></span><span>${
                l.points >= 0 ? '+' : ''
              }${l.points}</span></div>`,
          )
          .join('');
      scores.appendChild(card);
    }

    const rows: [string, (s: (typeof summary.scores)[0]) => string, boolean][] = [
      ['Shots fired', (s) => String(s.stats.shots), false],
      ['Shots on target', (s) => String(s.stats.hits), true],
      ['Accuracy', (s) => `${Math.round(s.accuracy * 100)}%`, true],
      ['Damage dealt', (s) => String(Math.round(s.stats.damageDealt)), true],
      ['Damage taken', (s) => String(Math.round(s.stats.damageTaken)), false],
      ['Heaviest single hit', (s) => String(Math.round(s.stats.bestHit)), true],
      ['Guns destroyed', (s) => String(s.stats.cannonsKilled), true],
      ['Masonry destroyed', (s) => String(s.stats.structuresKilled), true],
      ['Barrels detonated', (s) => String(s.stats.barrelsPopped), true],
      ['Hits on the king', (s) => String(s.stats.kingHits), true],
      ['Longest shot', (s) => `${Math.round(s.stats.longestShot)} m`, true],
      ['Credits earned', (s) => String(Math.round(s.stats.creditsEarned)), true],
    ];
    const table = $<HTMLTableElement>('over-stats');
    table.innerHTML =
      `<tr><th></th><th style="color:var(--red)">${escapeHtml(summary.scores[0].name)}</th>` +
      `<th style="color:var(--blue)">${escapeHtml(summary.scores[1].name)}</th></tr>` +
      rows
        .map(([label, get, higherWins]) => {
          const a = get(summary.scores[0]);
          const b = get(summary.scores[1]);
          const na = parseFloat(a);
          const nb = parseFloat(b);
          const aWin = higherWins ? na > nb : na < nb;
          const bWin = higherWins ? nb > na : nb < na;
          return `<tr class="best"><td>${label}</td><td class="${aWin ? 'win' : ''}">${a}</td><td class="${
            bWin ? 'win' : ''
          }">${b}</td></tr>`;
        })
        .join('');
    void entities;
  }

  overVotes(info: RoomInfo | null): void {
    if (!info) return;
    const votes = info.rematchVotes.length;
    $('over-votes').textContent = votes > 0 ? `${votes} of 2 want another round.` : '';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
