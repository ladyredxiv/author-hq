import { getSetting } from '../config.js';

export async function getBufferRunway(penName) {
  const token = getSetting('BUFFER_TOKEN');
  const organizationId = getSetting('BUFFER_ORGANIZATION_ID');
  const channels = JSON.parse(penName.buffer_channels || '{}');
  if (!token || Object.keys(channels).length === 0) {
    return { configured: false, channels: [] };
  }

  const results = await Promise.all(Object.entries(channels).map(async ([platform, channelId]) => {
    const scheduled = await getChannelScheduledPosts(token, organizationId, channelId);
    const last = scheduled
      .map((post) => post.scheduled_at || post.due_at || post.created_at)
      .filter(Boolean)
      .sort()
      .at(-1);
    return {
      platform,
      channelId,
      scheduledCount: scheduled.length,
      scheduledThrough: last || null,
      daysLeft: last ? Math.max(0, Math.round((new Date(last) - new Date()) / 86400000)) : 0
    };
  }));
  return { configured: true, channels: results };
}

async function getChannelScheduledPosts(token, organizationId, channelId) {
  const url = 'https://api.buffer.com/graphql';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const body = {
    query: `query GetScheduledPosts($input: PostsInput!, $first: Int) {
      posts(input: $input, first: $first) {
        edges { node { dueAt } }
      }
    }`,
    variables: {
      input: {
        organizationId,
        filter: { channelIds: [channelId], status: ['scheduled'] },
        sort: [{ field: 'dueAt', direction: 'desc' }]
      },
      first: 100
    }
  };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) return [];
    const data = await response.json();
    const edges = data.data?.posts?.edges || [];
    return edges.map((edge) => ({ scheduled_at: edge.node?.dueAt })).filter((post) => post.scheduled_at);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
