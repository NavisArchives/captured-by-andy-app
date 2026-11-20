// One WebGL2 program renders a photo through the basic sliders and a look
// (a 33³ colour table baked by the Rust side). The same code draws the live
// editor, the little previews in the looks strip and full-size exports, so
// what you see is exactly what you export.
import { assets } from "../api";
import type { Adjustments } from "../types";

export const LUT_SIZE = 33;

const VERTEX = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = (a_pos + 1.0) * 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D u_image;
uniform sampler3D u_lut;
uniform bool u_hasLut;
uniform bool u_original;
uniform float u_strength;
uniform float u_exposure, u_contrast, u_highlights, u_shadows, u_whites, u_blacks;
uniform float u_temp, u_tint, u_vibrance, u_saturation, u_grain, u_vignette;
uniform float u_fade, u_soften, u_halation, u_fringe, u_scanlines, u_weave, u_leak;
uniform vec4 u_crop;
uniform bool u_log;
uniform float u_rotate;
uniform float u_imgAspect;
uniform float u_split;
uniform vec2 u_size;
uniform float u_seed;
in vec2 v_uv;
out vec4 outColor;

float s2l(float x) { return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4); }
float l2s(float x) { x = max(x, 0.0); return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
vec3 s2l(vec3 c) { return vec3(s2l(c.r), s2l(c.g), s2l(c.b)); }
vec3 l2s(vec3 c) { return vec3(l2s(c.r), l2s(c.g), l2s(c.b)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Same maths as the Rust preset baker, so sliders and presets agree.
vec3 develop(vec3 c) {
  vec3 lin = s2l(c);
  float t = u_temp / 100.0, m = u_tint / 100.0;
  lin *= vec3(1.0 + 0.18 * t + 0.04 * m, 1.0 - 0.12 * m, 1.0 - 0.18 * t + 0.04 * m);
  lin *= exp2(u_exposure);
  vec3 v = l2s(lin);
  float l0 = luma(v);
  float l = l0;
  float lc = clamp(l, 0.0, 1.0);
  l += (u_contrast / 100.0) * (lc * lc * (3.0 - 2.0 * lc) - lc);
  float h = u_highlights / 100.0;
  float wh = smoothstep(0.45, 1.0, l);
  l += h < 0.0 ? h * 0.35 * wh * l : h * 0.2 * wh * max(1.2 - l, 0.0);
  l += (u_shadows / 100.0) * 0.25 * (1.0 - smoothstep(0.0, 0.55, l)) * smoothstep(0.0, 0.15, l);
  l += (u_whites / 100.0) * 0.15 * smoothstep(0.6, 1.0, l);
  l += (u_blacks / 100.0) * 0.12 * (1.0 - smoothstep(0.0, 0.35, l));
  v = l0 > 1e-4 ? v * (l / l0) : v + (l - l0);
  v = clamp(v, 0.0, 1.0);
  float chroma = max(v.r, max(v.g, v.b)) - min(v.r, min(v.g, v.b));
  float y = luma(v);
  float f = (1.0 + u_vibrance / 100.0 * (1.0 - chroma)) * (1.0 + u_saturation / 100.0);
  return clamp(y + (v - y) * f, 0.0, 1.0);
}

vec3 look(vec3 v) {
  if (!u_hasLut || u_strength <= 0.0) return v;
  float n = ${LUT_SIZE}.0;
  vec3 l = texture(u_lut, v * ((n - 1.0) / n) + 0.5 / n).rgb;
  return mix(v, l, u_strength);
}

// Film grain. A hash that never repeats (no lattice to see), soft clumps
// between grain centres, three clump sizes turned at different angles so no
// grid ever shows, spread like a bell curve, with a little colour in it like
// a film scan.
uint scramble(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  return x ^ (x >> 16u);
}
uint cellHash(ivec2 c, uint layer) {
  return scramble(uint(c.x) ^ scramble(uint(c.y) ^ scramble(layer)));
}
// Mean 0, spread 1, bell-shaped: four random bytes added up.
float bell(ivec2 c, uint layer) {
  uvec4 b = (uvec4(cellHash(c, layer)) >> uvec4(0u, 8u, 16u, 24u)) & 255u;
  return (dot(vec4(b), vec4(1.0)) / 255.0 - 2.0) * 1.732;
}
vec2 easeCell(vec2 p, out ivec2 c) {
  vec2 i = floor(p);
  c = ivec2(i);
  vec2 f = p - i;
  return f * f * (3.0 - 2.0 * f);
}
float clump(vec2 p, uint layer) {
  ivec2 c;
  vec2 f = easeCell(p, c);
  return mix(mix(bell(c, layer), bell(c + ivec2(1, 0), layer), f.x),
             mix(bell(c + ivec2(0, 1), layer), bell(c + ivec2(1, 1), layer), f.x), f.y);
}
// Three independent values (spread 1 each) from one hash, for the colour part.
vec3 rgbAt(ivec2 c, uint layer) {
  uvec3 b = (uvec3(cellHash(c, layer)) >> uvec3(0u, 8u, 16u)) & 255u;
  return (vec3(b) / 255.0 - 0.5) * 3.464;
}
vec3 clumpRgb(vec2 p, uint layer) {
  ivec2 c;
  vec2 f = easeCell(p, c);
  return mix(mix(rgbAt(c, layer), rgbAt(c + ivec2(1, 0), layer), f.x),
             mix(rgbAt(c + ivec2(0, 1), layer), rgbAt(c + ivec2(1, 1), layer), f.x), f.y);
}
vec2 turn(vec2 p, float a) { return mat2(cos(a), sin(a), -sin(a), cos(a)) * p; }
// \`p\` in grain units; spread about 1 per channel.
vec3 filmGrain(vec2 p) {
  uint s = uint(u_seed);
  // Kept positive: the hash takes whole numbers from 0 up.
  vec2 o = vec2(8192.0);
  float l = clump(turn(p, 0.43) + o, s)
          + 0.55 * clump(turn(p, 1.37) / 2.1 + o, s + 1u)
          + 0.25 * clump(turn(p, 2.29) / 4.3 + o, s + 2u);
  // Soft clumps average out a little: 0.87 brings the spread back to 1.
  return vec3(l / 0.87) + 0.22 * clumpRgb(turn(p, 0.91) + o, s + 3u) / 0.74;
}

// Sony S-Log3 / S-Gamut3.Cine to normal (sRGB) colour: decode the log curve,
// convert the primaries, then a soft film-like roll-off for the highlights.
float slog3(float v) {
  return v >= 171.2102946929 / 1023.0
    ? pow(10.0, (v * 1023.0 - 420.0) / 261.5) * 0.19 - 0.01
    : (v * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0);
}
vec3 fromSlog3(vec3 c) {
  vec3 lin = vec3(slog3(c.r), slog3(c.g), slog3(c.b));
  lin = mat3(1.6269474, -0.1785155, -0.0444361, -0.5401385, 1.4179409, -0.1959199, -0.0868089, -0.2394254, 1.2403560) * lin;
  lin = max(lin * 0.8, 0.0);
  vec3 t = clamp((lin * (2.51 * lin + 0.03)) / (lin * (2.43 * lin + 0.59) + 0.14), 0.0, 1.0);
  return mix(t * 12.92, 1.055 * pow(t, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, t));
}

// The picture at an output position (y down, 0..1): framed (cropped and
// turned clockwise by u_rotate around the crop's centre, in pixel space so it
// stays square), and converted from S-Log3 when it was filmed in it, like a RAW.
vec3 picture(vec2 q) {
  vec2 centre = u_crop.xy + 0.5 * u_crop.zw;
  vec2 p = (vec2(q.x, 1.0 - q.y) - 0.5) * u_crop.zw * vec2(u_imgAspect, 1.0);
  float cs = cos(u_rotate);
  float sn = sin(u_rotate);
  p = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y);
  vec2 uv = centre + p / vec2(u_imgAspect, 1.0);
  // Image rows are uploaded top-first (ImageBitmap ignores UNPACK_FLIP_Y), so flip here.
  vec3 c = texture(u_image, vec2(uv.x, 1.0 - uv.y)).rgb;
  return u_log ? fromSlog3(c) : c;
}

// A soft blur of the picture: twelve taps on two rings, radius r (of the height).
vec3 blurred(vec2 q, float r) {
  vec2 k = vec2(r * u_size.y / u_size.x, r);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5236 + (i < 6 ? 0.0 : 0.2618);
    sum += picture(q + vec2(cos(a), sin(a)) * k * (i < 6 ? 0.5 : 1.0));
  }
  return sum / 12.0;
}

// Random 0..1 for a whole number (a frame, a row).
float rand(uint n) { return float(scramble(n) & 65535u) / 65535.0; }

void main() {
  vec2 q = vec2(v_uv.x, 1.0 - v_uv.y);
  bool original = u_original || (u_split >= 0.0 && v_uv.x < u_split);
  uint frame = uint(u_seed);
  vec3 c;
  if (original) {
    c = picture(q);
  } else {
    // Gate weave: the frame drifts a little, a new place every frame.
    q += (vec2(rand(frame * 7u + 1u), rand(frame * 7u + 2u)) - 0.5) * (u_weave / 100.0) * vec2(0.004, 0.006);
    // Tape: each line slips sideways a touch.
    float rows = 240.0;
    q.x += (rand(uint(q.y * rows) + frame * 977u) - 0.5) * (u_scanlines / 100.0) * 0.0025;
    c = picture(q);
    // Colour fringes: red and blue spread apart towards the edges, like a cheap lens.
    if (u_fringe > 0.0) {
      vec2 d = q - 0.5;
      float k = (u_fringe / 100.0) * 0.008;
      c = vec3(picture(0.5 + d * (1.0 + k)).r, c.g, picture(0.5 + d * (1.0 - k)).b);
    }
    if (u_soften > 0.0) c = mix(c, blurred(q, 0.006), 0.75 * u_soften / 100.0);
    c = look(develop(c));
    // Halation: a red-orange glow bleeding from the highlights, like film.
    if (u_halation > 0.0) {
      vec3 h = blurred(q, 0.018);
      float glow = smoothstep(0.55, 1.0, luma(h));
      c += vec3(1.0, 0.32, 0.12) * glow * (u_halation / 100.0) * 0.55;
    }
    // Fade: lifted blacks and softer whites, a matte print.
    float fd = u_fade / 100.0;
    c = c * (1.0 - 0.14 * fd) + 0.1 * fd;
    // Scan lines.
    c *= 1.0 - (u_scanlines / 100.0) * 0.16 * (0.5 + 0.5 * cos(6.2832 * q.y * rows));
    // Light leak: warm light washing in from one side, moving slowly.
    if (u_leak > 0.0) {
      float t = float(frame) * 0.02;
      vec2 at = vec2(-0.05 + 0.1 * sin(t), 0.35 + 0.25 * sin(t * 0.63 + 1.0));
      vec2 d = (q - at) * vec2(u_size.x / u_size.y, 1.0);
      float w = exp(-dot(d, d) / 0.12) * (u_leak / 100.0) * 0.85;
      c = 1.0 - (1.0 - c) * (1.0 - w * vec3(1.0, 0.5, 0.18));
    }
    float aspect = u_size.x / u_size.y;
    vec2 dv = (v_uv - 0.5) * vec2(aspect, 1.0);
    float r = length(dv) / length(vec2(aspect, 1.0) * 0.5);
    c *= 1.0 + (u_vignette / 100.0) * 0.85 * smoothstep(0.35, 1.05, r);
    if (u_grain > 0.0) {
      // Grain sized to the picture, not the screen: same look at any zoom.
      float cell = max(1.0, u_size.x / 1400.0) * 1.35;
      vec3 g = filmGrain(v_uv * u_size / cell);
      float y = luma(c);
      // Strongest in the midtones, like film.
      c += g * (u_grain / 100.0) * 0.046 * (0.35 + 0.65 * (1.0 - abs(2.0 * y - 1.0)));
    }
  }
  if (u_split >= 0.0 && abs(v_uv.x - u_split) < 1.0 / u_size.x) c = vec3(1.0);
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const UNIFORMS = [
  "u_image", "u_lut", "u_hasLut", "u_original", "u_strength", "u_exposure", "u_contrast", "u_highlights",
  "u_shadows", "u_whites", "u_blacks", "u_temp", "u_tint", "u_vibrance", "u_saturation", "u_grain",
  "u_vignette", "u_crop", "u_log", "u_rotate", "u_imgAspect", "u_split", "u_size", "u_seed",
  "u_fade", "u_soften", "u_halation", "u_fringe", "u_scanlines", "u_weave", "u_leak",
] as const;

export interface RenderOptions {
  width: number;
  height: number;
  adjustments: Adjustments;
  strength: number;
  /** Part of the image to draw, 0..1: x, y, w, h (y from the bottom). */
  crop?: [number, number, number, number];
  /** Clockwise turn of the crop around its centre, in radians. */
  rotate?: number;
  /** The image is S-Log3 video: convert it to normal colour first. */
  log?: boolean;
  /** Show the original left of this x (0..1); -1 for none. */
  split?: number;
  original?: boolean;
  /** Which grain: a new one for every frame of a playing video. */
  seed?: number;
}

// LUT bytes are shared by every renderer and fetched once per look.
const lutBytes = new Map<string, Promise<Uint8Array>>();
export function loadLut(id: string): Promise<Uint8Array> {
  let p = lutBytes.get(id);
  if (!p) {
    p = assets.lut(id);
    p.catch(() => lutBytes.delete(id));
    lutBytes.set(id, p);
    if (lutBytes.size > 240) lutBytes.delete(lutBytes.keys().next().value as string);
  }
  return p;
}

export async function loadBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image ${res.status}`);
  return createImageBitmap(await res.blob());
}

export class LookRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private loc: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  private image: WebGLTexture;
  private emptyLut: WebGLTexture;
  private luts = new Map<string, WebGLTexture>();
  private lut: string | null = null;
  imageWidth = 0;
  imageHeight = 0;

  constructor(canvas?: HTMLCanvasElement, preserve = false) {
    this.canvas = canvas ?? document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", { preserveDrawingBuffer: preserve, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
    this.program = program;
    gl.useProgram(program);
    this.loc = Object.fromEntries(UNIFORMS.map((u) => [u, gl.getUniformLocation(program, u)])) as LookRenderer["loc"];

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    this.image = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.image);
    for (const [k, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.emptyLut = this.makeLut(new Uint8Array(4 * 8), 2);
  }

  private makeLut(data: Uint8Array, size = LUT_SIZE): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  /** A picture, or a video's current frame. */
  setImage(source: ImageBitmap | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.image);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const video = source instanceof HTMLVideoElement;
    this.imageWidth = video ? source.videoWidth : source.width;
    this.imageHeight = video ? source.videoHeight : source.height;
  }

  /** Uses a look whose table is already loaded (see `loadLut`); null for none. */
  setLut(id: string | null, data?: Uint8Array) {
    if (id && !this.luts.has(id)) {
      if (!data || data.length !== LUT_SIZE ** 3 * 4) {
        this.lut = null;
        return;
      }
      this.luts.set(id, this.makeLut(data));
      if (this.luts.size > 48) {
        const [oldest, tex] = this.luts.entries().next().value as [string, WebGLTexture];
        if (oldest !== id) {
          this.gl.deleteTexture(tex);
          this.luts.delete(oldest);
        }
      }
    }
    this.lut = id;
  }

  hasLut(id: string): boolean {
    return this.luts.has(id);
  }

  render(o: RenderOptions) {
    const gl = this.gl;
    if (this.canvas.width !== o.width || this.canvas.height !== o.height) {
      this.canvas.width = o.width;
      this.canvas.height = o.height;
    }
    gl.viewport(0, 0, o.width, o.height);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.image);
    gl.uniform1i(this.loc.u_image, 0);
    gl.activeTexture(gl.TEXTURE1);
    const lut = this.lut ? this.luts.get(this.lut) : undefined;
    gl.bindTexture(gl.TEXTURE_3D, lut ?? this.emptyLut);
    gl.uniform1i(this.loc.u_lut, 1);
    gl.uniform1i(this.loc.u_hasLut, lut ? 1 : 0);
    gl.uniform1i(this.loc.u_original, o.original ? 1 : 0);
    gl.uniform1f(this.loc.u_strength, o.strength);
    const a = o.adjustments;
    gl.uniform1f(this.loc.u_exposure, a.exposure);
    gl.uniform1f(this.loc.u_contrast, a.contrast);
    gl.uniform1f(this.loc.u_highlights, a.highlights);
    gl.uniform1f(this.loc.u_shadows, a.shadows);
    gl.uniform1f(this.loc.u_whites, a.whites);
    gl.uniform1f(this.loc.u_blacks, a.blacks);
    gl.uniform1f(this.loc.u_temp, a.temperature);
    gl.uniform1f(this.loc.u_tint, a.tint);
    gl.uniform1f(this.loc.u_vibrance, a.vibrance);
    gl.uniform1f(this.loc.u_saturation, a.saturation);
    gl.uniform1f(this.loc.u_grain, a.grain);
    gl.uniform1f(this.loc.u_vignette, a.vignette);
    gl.uniform1f(this.loc.u_fade, a.fade ?? 0);
    gl.uniform1f(this.loc.u_soften, a.soften ?? 0);
    gl.uniform1f(this.loc.u_halation, a.halation ?? 0);
    gl.uniform1f(this.loc.u_fringe, a.fringe ?? 0);
    gl.uniform1f(this.loc.u_scanlines, a.scanlines ?? 0);
    gl.uniform1f(this.loc.u_weave, a.weave ?? 0);
    gl.uniform1f(this.loc.u_leak, a.leak ?? 0);
    gl.uniform4fv(this.loc.u_crop, o.crop ?? [0, 0, 1, 1]);
    gl.uniform1f(this.loc.u_rotate, o.rotate ?? 0);
    gl.uniform1i(this.loc.u_log, o.log ? 1 : 0);
    gl.uniform1f(this.loc.u_imgAspect, this.imageWidth / Math.max(1, this.imageHeight));
    gl.uniform1f(this.loc.u_split, o.split ?? -1);
    gl.uniform2f(this.loc.u_size, o.width, o.height);
    gl.uniform1f(this.loc.u_seed, o.seed ?? 17);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    const gl = this.gl;
    for (const t of this.luts.values()) gl.deleteTexture(t);
    gl.deleteTexture(this.image);
    gl.deleteTexture(this.emptyLut);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** Crop rectangle (0..1) that fills `aspect` from the image centre. */
export function centreCrop(imageW: number, imageH: number, aspect: number | null): [number, number, number, number] {
  if (!aspect) return [0, 0, 1, 1];
  const imageAspect = imageW / imageH;
  if (imageAspect > aspect) {
    const w = aspect / imageAspect;
    return [(1 - w) / 2, 0, w, 1];
  }
  const h = imageAspect / aspect;
  return [0, (1 - h) / 2, 1, h];
}

export interface ExportSpec {
  /** Output aspect (w/h), or null to keep the photo's. */
  aspect: number | null;
  /** Output width in pixels (the long edge with `longEdge`). */
  width: number;
  /** `width` is the long edge, not the width (« 2048 px long edge »). */
  longEdge?: boolean;
  /** JPEG quality, 0–1 (default 0.92). */
  quality?: number;
}

export const EXPORTS: { id: string; label: string; spec: ExportSpec }[] = [
  { id: "tall", label: "Instagram 3:4 · 1080 × 1440 (fills the grid)", spec: { aspect: 3 / 4, width: 1080 } },
  { id: "portrait", label: "Instagram 4:5 · 1080 × 1350", spec: { aspect: 4 / 5, width: 1080 } },
  { id: "square", label: "Instagram 1:1 · 1080 × 1080", spec: { aspect: 1, width: 1080 } },
  { id: "story", label: "Story 9:16 · 1080 × 1920", spec: { aspect: 9 / 16, width: 1080 } },
  { id: "original", label: "Original ratio · 2560 px", spec: { aspect: null, width: 2560 } },
];

/** Renders a finished JPEG of a photo with its look and sliders. */
export async function renderExport(
  imageUrl: string,
  lutId: string | null,
  strength: number,
  adjustments: Adjustments,
  spec: ExportSpec,
): Promise<Uint8Array> {
  const bitmap = await loadBitmap(imageUrl);
  const r = new LookRenderer(undefined, true);
  try {
    r.setImage(bitmap);
    if (lutId) r.setLut(lutId, await loadLut(lutId));
    const { crop, rotate } = cropFor(bitmap.width, bitmap.height, spec.aspect, adjustments);
    const cropAspect = (bitmap.width * crop[2]) / (bitmap.height * crop[3]);
    // Never upscale past the source: a smaller sharp file beats a big soft one.
    const srcW = bitmap.width * crop[2];
    const wanted = spec.longEdge && cropAspect < 1 ? spec.width * cropAspect : spec.width;
    const width = Math.round(Math.min(wanted, srcW));
    const height = Math.round(width / cropAspect);
    r.render({ width, height, adjustments, strength, crop, rotate });
    const blob = await new Promise<Blob | null>((resolve) => r.canvas.toBlob(resolve, "image/jpeg", spec.quality ?? 0.92));
    if (!blob) throw new Error("could not encode the JPEG");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    r.dispose();
    bitmap.close();
  }
}

/**
 * One frame of a video as a JPEG, through the same renderer as the editor:
 * the look, sliders, crop (`aspect`, null for the video's own shape) and the
 * editor's still grain. `src` should be the original file, for full size.
 */
export async function renderVideoStill(
  src: string,
  at: number,
  lutId: string | null,
  strength: number,
  adjustments: Adjustments,
  aspect: number | null,
  log: boolean,
): Promise<Uint8Array> {
  const v = document.createElement("video");
  v.crossOrigin = "anonymous";
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  const r = new LookRenderer(undefined, true);
  try {
    await new Promise<void>((resolve, reject) => {
      v.addEventListener("loadeddata", () => resolve(), { once: true });
      v.addEventListener("error", () => reject(new Error("the video couldn't be opened (is Google Drive running?)")), { once: true });
      v.src = src;
    });
    const seeked = new Promise<void>((resolve) => v.addEventListener("seeked", () => resolve(), { once: true }));
    v.currentTime = Math.max(0, Math.min(at, (v.duration || at) - 0.05));
    await seeked;
    // WebKit may not have decoded the frame right after a seek: wait until it's shown.
    await new Promise<void>((resolve) => {
      const done = window.setTimeout(resolve, 600);
      v.requestVideoFrameCallback?.(() => {
        window.clearTimeout(done);
        resolve();
      });
    });
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    r.setImage(v);
    if (lutId) r.setLut(lutId, await loadLut(lutId));
    const W = v.videoWidth;
    const H = v.videoHeight;
    if (!W || !H) throw new Error("the frame couldn't be read");
    const { crop, rotate } = cropFor(W, H, aspect, adjustments);
    const width = Math.round(W * crop[2]);
    const height = Math.round(width / ((W * crop[2]) / (H * crop[3])));
    r.render({ width, height, adjustments, strength, crop, rotate, log, seed: 17 });
    const blob = await new Promise<Blob | null>((resolve) => r.canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) throw new Error("could not encode the JPEG");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    r.dispose();
    v.removeAttribute("src");
    v.load();
  }
}

/** A post's export ratio as width / height. */
export function ratioAspect(ratio: string): number {
  return ratio === "4:5" ? 4 / 5 : ratio === "1:1" ? 1 : 3 / 4;
}

/** The export size for a post's ratio. */
export function exportFor(ratio: string): ExportSpec {
  return (EXPORTS.find((e) => e.id === (ratio === "4:5" ? "portrait" : ratio === "1:1" ? "square" : "tall")) ?? EXPORTS[0]).spec;
}

/** The profile grid's tile: 3:4 since January 2025. */
export const GRID_TILE = 3 / 4;

/**
 * The part of a photo Instagram's 3:4 grid tile shows: first the post's
 * export frame (centred), then the tile inside it, moved by `offset` (-1 to 1)
 * along whichever side has room, like Instagram's "Adjust preview".
 */
export function tileCrop(width: number, height: number, exportAspect: number, offset: number, adj?: Partial<Adjustments>): Frame {
  const frame = cropFor(width, height, exportAspect, adj);
  const [fx, fy, fw, fh] = frame.crop;
  const frameAspect = (width * fw) / (height * fh);
  const t = Math.max(-1, Math.min(1, offset));
  if (frameAspect > GRID_TILE) {
    // Wider than the tile: it moves left and right.
    const tw = fw * (GRID_TILE / frameAspect);
    return { crop: [fx + ((fw - tw) / 2) * (1 + t), fy, tw, fh], rotate: frame.rotate };
  }
  const th = fh * (frameAspect / GRID_TILE);
  return { crop: [fx, fy + ((fh - th) / 2) * (1 + t), fw, th], rotate: frame.rotate };
}

/** What to draw of a photo: a rectangle (0..1, y from the bottom) and a clockwise turn. */
export interface Frame {
  crop: [number, number, number, number];
  rotate: number;
}

/**
 * A photo's frame for an output ratio (null: its own), following its crop:
 * straightened by `straighten` degrees (clockwise), zoomed in by `cropZoom`
 * (0..100, 100 = twice as close) and centred `cropX` / `cropY` percent away from
 * the middle (down is positive). The frame always stays inside the photo.
 */
export function cropFor(imageW: number, imageH: number, aspect: number | null, adj?: Partial<Adjustments>): Frame {
  const W = Math.max(1, imageW);
  const H = Math.max(1, imageH);
  const a = aspect ?? W / H;
  let w = W;
  let h = W / a;
  if (h > H) {
    h = H;
    w = H * a;
  }
  const zoom = 1 + Math.max(0, Math.min(100, adj?.cropZoom ?? 0)) / 100;
  w /= zoom;
  h /= zoom;
  const deg = Math.max(-45, Math.min(45, adj?.straighten ?? 0));
  const t = (Math.abs(deg) * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // Turned, the frame must still fit: shrink it until its bounding box does.
  const fit = Math.min(1, W / (w * c + h * s), H / (w * s + h * c));
  w *= fit;
  h *= fit;
  const bw = w * c + h * s;
  const bh = w * s + h * c;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const cx = clamp(W * (0.5 + (adj?.cropX ?? 0) / 100), bw / 2, W - bw / 2);
  const cy = clamp(H * (0.5 + (adj?.cropY ?? 0) / 100), bh / 2, H - bh / 2);
  return { crop: [(cx - w / 2) / W, 1 - (cy + h / 2) / H, w / W, h / H], rotate: (deg * Math.PI) / 180 };
}
