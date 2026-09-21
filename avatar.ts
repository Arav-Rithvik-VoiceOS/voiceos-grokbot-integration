import type { Agent } from "./client.ts";
import { avatarShapes } from "./avatarShapes.generated.ts";

// Grok Bot 0.57.0: dark avatar colors, distinct from the creation picker palette.
const colors = {
  black: "#FFFFFF",
  brown: "#855C36",
  red: "#E02135",
  orange: "#FF6700",
  yellow: "#FF9800",
  green: "#009957",
  cyan: "#00A592",
  blue: "#0E74E0",
  violet: "#804EE0",
  magenta: "#E02A88",
  gray: "#777777",
} as const;
const defaultColors = Object.keys(colors).filter(
  (c) => c !== "black",
) as (keyof typeof colors)[];
const defaultShapes = [
  "blob",
  "pebble",
  "squircle",
  "tablet",
  "wedge",
  "hex",
  "cloud",
  "teardrop",
] as const;

function hashId(id: string) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++)
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// Grok assigns missing avatar fields deterministically from the bot ID.
export function defaultAvatar(id: string) {
  const hash = hashId(id);
  const seed = (hash + 1831565813) | 0;
  let random = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  random = (random + Math.imul(random ^ (random >>> 7), 61 | random)) ^ random;
  const fraction = ((random ^ (random >>> 14)) >>> 0) / 4294967296;
  let shapeHash = Math.imul(hash ^ (hash >>> 16), 73244475);
  shapeHash = Math.imul(shapeHash ^ (shapeHash >>> 13), 3266489909);
  return {
    color: defaultColors[Math.floor(fraction * defaultColors.length)],
    shape:
      defaultShapes[
        ((shapeHash ^ (shapeHash >>> 16)) >>> 0) % defaultShapes.length
      ],
  };
}

export function avatarFor(agent: Agent) {
  const fallback = defaultAvatar(agent.id);
  const color = agent.avatarColor?.toLowerCase() ?? fallback.color;
  const shape = agent.avatarShape?.toLowerCase() ?? fallback.shape;
  const picture = agent.avatarDataUrl;
  return {
    color:
      colors[color as keyof typeof colors] ??
      (/^#[0-9a-f]{6}$/i.test(color) ? color : colors[fallback.color]),
    shape: Object.hasOwn(avatarShapes, shape) ? shape : fallback.shape,
    // Only small embedded raster images belong in the sandboxed card payload.
    ...(picture &&
    picture.length <= 12000 &&
    /^data:image\/(png|jpeg|webp|gif);base64,[a-z\d+/=]+$/i.test(picture)
      ? { picture }
      : {}),
  };
}

export const avatarCss = `
.avatar{position:relative;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;flex:none;vertical-align:middle}
.avatar svg,.avatar-picture{display:block;width:100%;height:100%;flex:none}.avatar-picture{object-fit:cover;border-radius:50%}
.avatar .working-dot{position:absolute;right:1px;bottom:1px;width:8px;height:8px;background:#00c972;border-radius:50%;box-shadow:0 0 0 2px var(--avatar-ring,#111)}
.group-avatar>.avatar{position:absolute;width:66.667%;height:66.667%}.group-avatar>.avatar:first-child{left:0;top:0}.group-avatar>.avatar:nth-child(2){right:0;bottom:0}
.group-avatar[data-count="3"]>.avatar,.group-avatar[data-count="4"]>.avatar{width:55.556%;height:55.556%}
.group-avatar[data-count="3"]>.avatar:first-child{left:22.222%;top:0}.group-avatar[data-count="3"]>.avatar:nth-child(2){left:0;top:auto;bottom:0}.group-avatar[data-count="3"]>.avatar:nth-child(3){right:0;bottom:0}
.group-avatar[data-count="4"]>.avatar:nth-child(2){right:0;top:0;bottom:auto}.group-avatar[data-count="4"]>.avatar:nth-child(3){left:0;bottom:0}.group-avatar[data-count="4"]>.avatar:nth-child(4){right:0;bottom:0}
.avatar-overflow{border-radius:50%;background:#303030;color:#bbb;font-size:10px}.status-marker{width:8px;height:8px;border-radius:50%;flex:none;margin-left:5px;background:#369eff}.status-marker.attention{background:#ff9800}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;

/** Both live cards and frozen confirmations supply their current roster. */
export function buildAvatarRuntime(rosterExpression = "bots") {
  return String.raw`
const shapes=${JSON.stringify(avatarShapes)};
function avatar(b,working=false){
 let content;
 const picture=typeof b.picture==='string'&&/^data:image\/(png|jpeg|webp|gif);base64,[a-z\d+/=]+$/i.test(b.picture)?b.picture:null;
 if(!picture&&(b.isGroup||Array.isArray(b.members))){
  const members=(b.members||[]).map(id=>(${rosterExpression}).find(member=>member.id===id)).filter(Boolean),shown=members.slice(0,members.length>4?3:4);
  content=shown.map(member=>avatar(member)).join('');
  if(members.length>4)content+='<span class="avatar avatar-overflow">+'+(members.length-3)+'</span>';
  if(content)return '<span class="avatar group-avatar" data-count="'+Math.min(members.length,4)+'" aria-hidden="true">'+content+'</span>';
 }
 if(picture)content='<img class="avatar-picture" src="'+picture+'" alt="">';
 if(!content){const shape=shapes[b.shape]||shapes.blob,color=/^#[a-f0-9]{6}$/i.test(b.color)?b.color:'#777777';content='<svg viewBox="-15 -15 259 259" aria-hidden="true"><g transform="translate(114.2705 114.2705) scale('+shape.scale+') translate(-114.2705 -114.2705)"><path fill="'+color+'" fill-rule="evenodd" d="'+shape.path+'"/></g></svg>';}
 return '<span class="avatar" aria-hidden="true">'+content+(working?'<span class="working-dot"></span>':'')+'</span>';
}
`;
}

export const avatarRuntime = buildAvatarRuntime();
