import { basePath } from './net.ts';

export interface DiscordContext {
  instanceId: string;
  channelId?: string;
  guildId?: string;
  userId?: string;
  name?: string;
  authenticated: boolean;
}

/**
 * Injected at build time from DISCORD_CLIENT_ID. Without it the activity still
 * works — everyone in the same instance shares a battle — you just do not get
 * Discord display names.
 */
declare const __DISCORD_CLIENT_ID__: string;

function clientId(): string {
  try {
    return typeof __DISCORD_CLIENT_ID__ === 'string' ? __DISCORD_CLIENT_ID__ : '';
  } catch {
    return '';
  }
}

export function inDiscord(): boolean {
  const q = new URLSearchParams(location.search);
  return q.has('frame_id') || q.has('instance_id') || location.hostname.endsWith('discordsays.com');
}

/**
 * Resolves the Discord activity context. Falls back to the query parameters
 * Discord always supplies, so the SDK (and its OAuth round trip) is optional.
 */
export async function initDiscord(): Promise<DiscordContext | null> {
  if (!inDiscord()) return null;
  const q = new URLSearchParams(location.search);
  const fallback: DiscordContext = {
    instanceId: q.get('instance_id') ?? q.get('frame_id') ?? 'discord-default',
    channelId: q.get('channel_id') ?? undefined,
    guildId: q.get('guild_id') ?? undefined,
    authenticated: false,
  };

  const id = clientId();
  if (!id) return fallback;

  try {
    const { DiscordSDK } = await import('@discord/embedded-app-sdk');
    const sdk = new DiscordSDK(id);
    await sdk.ready();

    const ctx: DiscordContext = {
      ...fallback,
      instanceId: sdk.instanceId || fallback.instanceId,
      channelId: sdk.channelId ?? fallback.channelId,
      guildId: sdk.guildId ?? fallback.guildId,
    };

    try {
      const { code } = await sdk.commands.authorize({
        client_id: id,
        response_type: 'code',
        state: '',
        prompt: 'none',
        scope: ['identify', 'guilds.members.read'],
      });
      const res = await fetch(`${basePath()}/api/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        const { access_token } = (await res.json()) as { access_token: string };
        const auth = await sdk.commands.authenticate({ access_token });
        ctx.userId = auth.user.id;
        ctx.name = auth.user.global_name || auth.user.username;
        ctx.authenticated = true;
      }
    } catch (err) {
      console.warn('Discord auth skipped:', err);
    }
    return ctx;
  } catch (err) {
    console.warn('Discord SDK unavailable, using query context:', err);
    return fallback;
  }
}
