// Parsing of the payload that Notion's "Send webhook" automation action sends.
// Only page *properties* are included in the payload; page content is not.

/** Join rich text fragments (title / rich_text) into plain text. */
function plainText(fragments) {
  if (!Array.isArray(fragments)) return '';
  return fragments.map((f) => f?.plain_text ?? f?.text?.content ?? '').join('');
}

function formatDate(date) {
  if (!date || !date.start) return null;
  return date.end ? `${date.start} → ${date.end}` : date.start;
}

function formatUser(user) {
  if (!user) return null;
  return user.name ?? user.person?.email ?? user.id ?? null;
}

/** Value of a formula / rollup result object, whose shape mirrors a property value. */
function innerValue(obj) {
  if (!obj || typeof obj !== 'object') return null;
  switch (obj.type) {
    case 'string':
      return obj.string ?? null;
    case 'number':
      return obj.number ?? null;
    case 'boolean':
      return obj.boolean ?? null;
    case 'date':
      return formatDate(obj.date);
    case 'array':
      return (obj.array ?? []).map((item) => propertyValue(item)).filter((v) => v !== null && v !== '');
    default:
      return obj.type ? propertyValue(obj) : null;
  }
}

/**
 * Extract a plain JS value (string, number, boolean, string[] or null) from one Notion property.
 * Unknown or empty properties yield null.
 */
export function propertyValue(prop) {
  if (!prop || typeof prop !== 'object') return null;
  switch (prop.type) {
    case 'title':
      return plainText(prop.title);
    case 'rich_text':
      return plainText(prop.rich_text);
    case 'select':
      return prop.select?.name ?? null;
    case 'status':
      return prop.status?.name ?? null;
    case 'multi_select':
      return (prop.multi_select ?? []).map((o) => o.name);
    case 'number':
      return prop.number ?? null;
    case 'checkbox':
      return Boolean(prop.checkbox);
    case 'url':
      return prop.url ?? null;
    case 'email':
      return prop.email ?? null;
    case 'phone_number':
      return prop.phone_number ?? null;
    case 'date':
      return formatDate(prop.date);
    case 'relation':
      return (prop.relation ?? []).map((r) => r.id);
    case 'people':
      return (prop.people ?? []).map(formatUser).filter(Boolean);
    case 'files':
      return (prop.files ?? []).map((f) => f.name ?? f.file?.url ?? f.external?.url).filter(Boolean);
    case 'unique_id': {
      const u = prop.unique_id;
      if (!u || u.number == null) return null;
      return u.prefix ? `${u.prefix}-${u.number}` : String(u.number);
    }
    case 'created_time':
      return prop.created_time ?? null;
    case 'last_edited_time':
      return prop.last_edited_time ?? null;
    case 'created_by':
      return formatUser(prop.created_by);
    case 'last_edited_by':
      return formatUser(prop.last_edited_by);
    case 'formula':
      return innerValue(prop.formula);
    case 'rollup':
      return innerValue(prop.rollup);
    case 'verification':
      return prop.verification?.state ?? null;
    default:
      return null;
  }
}

/** Map of property name → extracted value. */
export function extractProperties(properties) {
  const out = {};
  if (!properties || typeof properties !== 'object') return out;
  for (const [name, prop] of Object.entries(properties)) {
    out[name] = propertyValue(prop);
  }
  return out;
}

/** Name of the page's title property, if any. */
export function titlePropertyName(properties) {
  if (!properties || typeof properties !== 'object') return null;
  for (const [name, prop] of Object.entries(properties)) {
    if (prop?.type === 'title') return name;
  }
  return null;
}

/**
 * Validate and normalise a Notion webhook payload.
 * Returns { ok: true, event } or { ok: false, reason }.
 */
export function parseWebhookPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'payload_not_object' };
  const source = body.source;
  const data = body.data;
  if (!source || typeof source !== 'object') return { ok: false, reason: 'missing_source' };
  if (!data || typeof data !== 'object') return { ok: false, reason: 'missing_data' };
  if (typeof source.event_id !== 'string' || !source.event_id) return { ok: false, reason: 'missing_event_id' };

  const properties = extractProperties(data.properties);
  const titleName = titlePropertyName(data.properties);

  return {
    ok: true,
    event: {
      eventId: source.event_id,
      attempt: Number.isInteger(source.attempt) ? source.attempt : null,
      automationId: typeof source.automation_id === 'string' ? source.automation_id : null,
      actionId: typeof source.action_id === 'string' ? source.action_id : null,
      clickerId: typeof source.user_id === 'string' ? source.user_id : null,
      pageId: typeof data.id === 'string' ? data.id : null,
      pageUrl: typeof data.url === 'string' ? data.url : null,
      publicUrl: typeof data.public_url === 'string' ? data.public_url : null,
      databaseId: data.parent?.database_id ?? null,
      dataSourceId: data.parent?.data_source_id ?? null,
      title: titleName ? properties[titleName] : null,
      properties,
    },
  };
}

/**
 * Parameters available in a captured payload: one entry per page property with its Notion type
 * and the formatted sample value. Used by the admin site after the setup test webhook.
 */
export function describeParameters(body) {
  const properties = body?.data?.properties;
  if (!properties || typeof properties !== 'object') return [];
  return Object.entries(properties).map(([name, prop]) => ({
    name,
    type: typeof prop?.type === 'string' ? prop.type : 'unknown',
    value: propertyValue(prop),
  }));
}
