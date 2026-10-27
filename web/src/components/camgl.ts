import { transpose, type Mat3 } from '../lib/camera'

/*
 * One WebGL2 view for the Camera panel. For every output pixel it takes the
 * ray of the (virtual) output camera, turns it into the source camera's ray
 * with the warp, and looks that up: in the webcam frame, or in a synthetic
 * world (sky, a far ridge, a gridded ground plane) seen along the source
 * camera's true orientation. Rays that leave the source frame are the
 * border a stabiliser has to crop. With an identity warp it is the camera.
 */

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`

const FS = `#version 300 es
precision highp float;
uniform vec2 uSize;   // output, device px
uniform float uF;     // output focal length, device px
uniform vec2 uSrc;    // source frame, px
uniform float uFs;    // source focal length, px
uniform mat3 uWarp;   // output ray -> source ray
uniform mat3 uCam;    // source camera -> NED, for the synthetic world
uniform int uVideo;
uniform sampler2D uTex;
out vec4 o;

const vec3 BORDER = vec3(0.027, 0.035, 0.031);
const vec3 SKY0 = vec3(0.16, 0.2, 0.18);
const vec3 SKY1 = vec3(0.05, 0.062, 0.056);

float gridLine(vec2 p) {
  vec2 g = abs(fract(p - 0.5) - 0.5) / max(fwidth(p), vec2(1e-4));
  return 1.0 - min(min(g.x, g.y), 1.0);
}

vec3 world(vec3 d) {
  float el = asin(clamp(-d.z, -1.0, 1.0));
  float az = atan(d.y, d.x);
  // ground: a plane 1.6 m below, gridded every metre and every 5 m, hazing out to the horizon
  float t = 1.6 / max(d.z, 1e-4);
  vec2 q = d.xy * t;
  float haze = exp(-t / 45.0);
  vec3 ground = vec3(0.055, 0.068, 0.06) + vec3(0.72, 0.83, 0.66) * (0.08 * gridLine(q) + 0.2 * gridLine(q / 5.0)) * haze;
  ground = mix(SKY0 * 0.45, ground, haze);
  // sky, a far ridge line (something for heading to hold on to), and the sun
  vec3 sky = mix(SKY0, SKY1, pow(clamp(el / 1.2, 0.0, 1.0), 0.6));
  float ridge = 0.03 + 0.022 * sin(3.0 * az + 1.3) + 0.014 * sin(7.0 * az + 0.2) + 0.008 * sin(13.0 * az + 2.1);
  sky = mix(sky, vec3(0.125, 0.155, 0.14), step(el, ridge));
  vec3 sun = vec3(cos(0.55) * cos(2.2), cos(0.55) * sin(2.2), -sin(0.55));
  float s = max(dot(d, sun), 0.0);
  sky += vec3(0.82, 0.9, 0.77) * (smoothstep(0.99935, 0.9996, s) * 0.85 + pow(s, 40.0) * 0.1);
  return el > 0.0 ? sky : ground;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);
  vec3 rr = uWarp * vec3((px - 0.5 * uSize) / uF, 1.0);
  vec2 sp = 0.5 * uSrc + uFs * rr.xy / max(rr.z, 1e-5);
  vec3 c = uVideo == 1 ? texture(uTex, sp / uSrc).rgb : world(normalize(uCam * rr));
  bool inside = rr.z > 1e-5 && sp.x >= 0.0 && sp.y >= 0.0 && sp.x <= uSrc.x && sp.y <= uSrc.y;
  // outside the source frame: what a stabiliser has to crop, hatched so it never reads as dark sky
  float hatch = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / (12.0 * uF / max(uFs, 1.0) + 6.0)));
  o = vec4(inside ? c : BORDER + hatch * 0.025, 1.0);
}`

export interface Draw {
  size: [number, number] // output, CSS px
  f: number // output focal length, CSS px
  src: [number, number] // source frame, px
  fSrc: number // source focal length, px
  warp: Mat3
  cam: Mat3
  video?: HTMLVideoElement | null
}

export interface GlView {
  draw(d: Draw): void
  dispose(): void
}

export function createView(canvas: HTMLCanvasElement): GlView | null {
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })
  if (!gl) return null
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
    return s
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS))
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link')
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const u = (n: string) => gl.getUniformLocation(prog, n)
  const U = { size: u('uSize'), f: u('uF'), src: u('uSrc'), fs: u('uFs'), warp: u('uWarp'), cam: u('uCam'), video: u('uVideo'), tex: u('uTex') }
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.uniform1i(U.tex, 0)

  return {
    draw(d) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.round(d.size[0] * dpr)
      const h = Math.round(d.size[1] * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      gl.viewport(0, 0, w, h)
      const video = d.video && d.video.readyState >= 2 ? d.video : null
      if (video) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
      gl.uniform2f(U.size, w, h)
      gl.uniform1f(U.f, d.f * dpr)
      gl.uniform2f(U.src, d.src[0], d.src[1])
      gl.uniform1f(U.fs, d.fSrc)
      // GLSL matrices are column-major
      gl.uniformMatrix3fv(U.warp, false, transpose(d.warp))
      gl.uniformMatrix3fv(U.cam, false, transpose(d.cam))
      gl.uniform1i(U.video, video ? 1 : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    dispose() {
      gl.deleteProgram(prog)
      gl.deleteBuffer(buf)
      gl.deleteTexture(tex)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
