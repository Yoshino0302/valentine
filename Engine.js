"use strict";
/* =========================
GLOBAL REGISTRY SYSTEM
Eliminates duplicate class crashes
Reduces LOC massively
========================= */
const __REG=globalThis.__KUROMI_REGISTRY??(globalThis.__KUROMI_REGISTRY=Object.create(null));
const __DEF=(name,cls)=>{
let existing=__REG[name];
if(existing)return existing;
__REG[name]=cls;
return cls;
};
const __DEFN=(name,fn)=>{
let existing=__REG[name];
if(existing)return existing;
__REG[name]=fn;
return fn;
};
/* =========================
AUTHORITY CONTAINER
Single source of truth
Integrity protected
========================= */
const AUTH=globalThis.__KUROMI_AUTH??(globalThis.__KUROMI_AUTH={
config:null,
gpu:null,
runtime:null,
renderer:null,
systems:null,
locked:false
});
const __freeze=o=>{
if(!o||typeof o!=="object"||Object.isFrozen(o))return o;
Object.freeze(o);
for(const k of Object.keys(o)){
const v=o[k];
if(v&&typeof v==="object")__freeze(v);
}
return o;
};
const __lockAuthority=()=>{
if(AUTH.locked)return;
__freeze(AUTH);
AUTH.locked=true;
};
const __assertAuthority=()=>{
if(!AUTH.locked)throw new Error("[KUROMI_AUTH] Authority integrity violation");
};
/* =========================
RUNTIME DETECTION
GPU + Browser capability detection
========================= */
const Runtime=__DEF("Runtime",class Runtime{
constructor(){
this.isBrowser=typeof window!=="undefined";
this.isWorker=typeof WorkerGlobalScope!=="undefined";
this.isNode=typeof process!=="undefined"&&process.versions!=null&&process.versions.node!=null;
this.now=performance?.now?.bind(performance)??Date.now;
this.frame=0;
this.delta=0;
this.time=0;
this.last=this.now();
}
tick(){
const now=this.now();
this.delta=(now-this.last)*0.001;
this.last=now;
this.time+=this.delta;
this.frame++;
}
});
/* =========================
GPU DETECTION
========================= */
const GPUCaps=__DEF("GPUCaps",class GPUCaps{
constructor(gl){
this.gl=gl;
this.isWebGL2=!!(globalThis.WebGL2RenderingContext&&gl instanceof WebGL2RenderingContext);
this.maxTextures=gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
this.maxTextureSize=gl.getParameter(gl.MAX_TEXTURE_SIZE);
this.maxCubeSize=gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE);
this.maxAttribs=gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
this.extensions={};
this.detectExtensions();
}
detectExtensions(){
const gl=this.gl;
const list=[
"EXT_color_buffer_float",
"OES_texture_float",
"OES_texture_float_linear",
"EXT_texture_filter_anisotropic",
"OES_standard_derivatives",
"WEBGL_depth_texture",
"WEBGL_draw_buffers"
];
for(const name of list){
this.extensions[name]=gl.getExtension(name);
}
}
});
/* =========================
MATH CORE
========================= */
const clamp=__DEFN("clamp",(x,a,b)=>x<a?a:x>b?b:x);
const lerp=__DEFN("lerp",(a,b,t)=>a+(b-a)*t);
const saturate=__DEFN("saturate",(x)=>x<0?0:x>1?1:x);
/* =========================
VEC3
========================= */
const Vec3=__DEF("Vec3",class Vec3{
constructor(x=0,y=0,z=0){
this.x=x;
this.y=y;
this.z=z;
}
set(x,y,z){
this.x=x;
this.y=y;
this.z=z;
return this;
}
copy(v){
this.x=v.x;
this.y=v.y;
this.z=v.z;
return this;
}
clone(){
return new Vec3(this.x,this.y,this.z);
}
add(v){
this.x+=v.x;
this.y+=v.y;
this.z+=v.z;
return this;
}
sub(v){
this.x-=v.x;
this.y-=v.y;
this.z-=v.z;
return this;
}
mulScalar(s){
this.x*=s;
this.y*=s;
this.z*=s;
return this;
}
length(){
return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z);
}
normalize(){
let len=this.length();
if(len>0){
this.x/=len;
this.y/=len;
this.z/=len;
}
return this;
}
});
/* =========================
COLOR SPECTRAL CORE
========================= */
const SpectralSample=__DEF("SpectralSample",class SpectralSample{
constructor(lambda=550,intensity=0){
this.lambda=lambda;
this.intensity=intensity;
}
clone(){
return new SpectralSample(this.lambda,this.intensity);
}
});
const SpectralDistribution=__DEF("SpectralDistribution",class SpectralDistribution{
constructor(){
this.samples=[];
}
add(lambda,intensity){
this.samples.push(new SpectralSample(lambda,intensity));
}
evaluate(lambda){
let closest=null;
let min=1e9;
for(const s of this.samples){
let d=Math.abs(s.lambda-lambda);
if(d<min){
min=d;
closest=s;
}
}
return closest?closest.intensity:0;
}
});
/* =========================
CAMERA CORE
========================= */
const Camera=__DEF("Camera",class Camera{
constructor(){
this.position=new Vec3();
this.rotation=new Vec3();
this.fov=60;
this.near=0.01;
this.far=1000;
this.aspect=1;
this.projectionMatrix=new Float32Array(16);
this.viewMatrix=new Float32Array(16);
}
updateProjection(){
const f=1/Math.tan(this.fov*Math.PI/360);
const nf=1/(this.near-this.far);
const m=this.projectionMatrix;
m[0]=f/this.aspect;
m[1]=0;
m[2]=0;
m[3]=0;
m[4]=0;
m[5]=f;
m[6]=0;
m[7]=0;
m[8]=0;
m[9]=0;
m[10]=(this.far+this.near)*nf;
m[11]=-1;
m[12]=0;
m[13]=0;
m[14]=(2*this.far*this.near)*nf;
m[15]=0;
}
});
/* =========================
SCENE CORE
========================= */
const Scene=__DEF("Scene",class Scene{
constructor(){
this.objects=[];
this.lights=[];
}
add(o){
this.objects.push(o);
}
addLight(l){
this.lights.push(l);
}
});
/* =========================
RENDERER BASE
========================= */
const Renderer=__DEF("Renderer",class Renderer{
constructor(canvas){
this.canvas=canvas;
this.gl=canvas.getContext("webgl2",{alpha:false,antialias:true})||
canvas.getContext("webgl",{alpha:false,antialias:true});
if(!this.gl)throw new Error("WebGL not supported");
this.runtime=new Runtime();
this.gpu=new GPUCaps(this.gl);
AUTH.renderer=this;
AUTH.gpu=this.gpu;
AUTH.runtime=this.runtime;
}
resize(){
const w=this.canvas.clientWidth;
const h=this.canvas.clientHeight;
if(this.canvas.width!==w||this.canvas.height!==h){
this.canvas.width=w;
this.canvas.height=h;
this.gl.viewport(0,0,w,h);
}
}
render(scene,camera){
this.runtime.tick();
this.resize();
this.gl.clearColor(0,0,0,1);
this.gl.clear(this.gl.COLOR_BUFFER_BIT|this.gl.DEPTH_BUFFER_BIT);
}
});
/* =========================
ENGINE CORE ENTRY
========================= */
const Engine=__DEF("Engine",class Engine{
constructor(canvas){
this.renderer=new Renderer(canvas);
this.scene=new Scene();
this.camera=new Camera();
AUTH.config=this;
__lockAuthority();
}
render(){
__assertAuthority();
this.renderer.render(this.scene,this.camera);
}
});
/* =========================
EXPORT
========================= */
globalThis.KUROMI={
Engine,
Renderer,
Scene,
Camera,
Vec3,
SpectralSample,
SpectralDistribution,
Runtime,
GPUCaps
};

const dot=__DEFN("dot",(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z);
const cross=__DEFN("cross",(a,b)=>{
return new Vec3(
a.y*b.z-a.z*b.y,
a.z*b.x-a.x*b.z,
a.x*b.y-a.y*b.x
);
});
const normalize=__DEFN("normalize",(v)=>{
let len=Math.sqrt(v.x*v.x+v.y*v.y+v.z*v.z);
if(len===0)return new Vec3();
return new Vec3(v.x/len,v.y/len,v.z/len);
});
const reflect=__DEFN("reflect",(v,n)=>{
let d=dot(v,n)*2;
return new Vec3(
v.x-d*n.x,
v.y-d*n.y,
v.z-d*n.z
);
});
/* =========================
RAY CORE
========================= */
const Ray=__DEF("Ray",class Ray{
constructor(origin=new Vec3(),direction=new Vec3(0,0,1)){
this.origin=origin.clone();
this.direction=normalize(direction);
}
at(t){
return new Vec3(
this.origin.x+this.direction.x*t,
this.origin.y+this.direction.y*t,
this.origin.z+this.direction.z*t
);
}
});
/* =========================
HIT RECORD
========================= */
const Hit=__DEF("Hit",class Hit{
constructor(){
this.position=new Vec3();
this.normal=new Vec3();
this.distance=Infinity;
this.object=null;
this.hit=false;
}
set(position,normal,distance,object){
this.position.copy(position);
this.normal.copy(normal);
this.distance=distance;
this.object=object;
this.hit=true;
}
});
/* =========================
TRANSFORM CORE
========================= */
const Transform=__DEF("Transform",class Transform{
constructor(){
this.position=new Vec3();
this.rotation=new Vec3();
this.scale=new Vec3(1,1,1);
this.matrix=new Float32Array(16);
this.worldMatrix=new Float32Array(16);
this.dirty=true;
}
updateMatrix(){
const sx=this.scale.x;
const sy=this.scale.y;
const sz=this.scale.z;
const tx=this.position.x;
const ty=this.position.y;
const tz=this.position.z;
const m=this.matrix;
m[0]=sx;m[1]=0;m[2]=0;m[3]=0;
m[4]=0; m[5]=sy;m[6]=0;m[7]=0;
m[8]=0;m[9]=0;m[10]=sz;m[11]=0;
m[12]=tx;m[13]=ty;m[14]=tz;m[15]=1;
this.dirty=false;
}
});
/* =========================
BASE OBJECT
========================= */
const Object3D=__DEF("Object3D",class Object3D{
constructor(){
this.transform=new Transform();
this.visible=true;
this.children=[];
this.parent=null;
this.geometry=null;
this.material=null;
}
add(child){
child.parent=this;
this.children.push(child);
}
});
/* =========================
GEOMETRY BASE
========================= */
const Geometry=__DEF("Geometry",class Geometry{
constructor(){
this.vertices=null;
this.normals=null;
this.uvs=null;
this.indices=null;
this.boundsMin=new Vec3();
this.boundsMax=new Vec3();
}
computeBounds(){
if(!this.vertices)return;
let min=new Vec3(Infinity,Infinity,Infinity);
let max=new Vec3(-Infinity,-Infinity,-Infinity);
for(let i=0;i<this.vertices.length;i+=3){
let x=this.vertices[i];
let y=this.vertices[i+1];
let z=this.vertices[i+2];
if(x<min.x)min.x=x;
if(y<min.y)min.y=y;
if(z<min.z)min.z=z;
if(x>max.x)max.x=x;
if(y>max.y)max.y=y;
if(z>max.z)max.z=z;
}
this.boundsMin=min;
this.boundsMax=max;
}
});
/* =========================
SPHERE GEOMETRY
========================= */
const SphereGeometry=__DEF("SphereGeometry",class SphereGeometry extends Geometry{
constructor(radius=1,segments=16){
super();
let verts=[];
let norms=[];
for(let y=0;y<=segments;y++){
let v=y/segments;
let phi=v*Math.PI;
for(let x=0;x<=segments;x++){
let u=x/segments;
let theta=u*Math.PI*2;
let sx=Math.cos(theta)*Math.sin(phi);
let sy=Math.cos(phi);
let sz=Math.sin(theta)*Math.sin(phi);
verts.push(sx*radius,sy*radius,sz*radius);
norms.push(sx,sy,sz);
}
}
this.vertices=new Float32Array(verts);
this.normals=new Float32Array(norms);
this.computeBounds();
}
});
/* =========================
PLANE GEOMETRY
========================= */
const PlaneGeometry=__DEF("PlaneGeometry",class PlaneGeometry extends Geometry{
constructor(size=1){
super();
this.vertices=new Float32Array([
-size,0,-size,
size,0,-size,
size,0,size,
-size,0,size
]);
this.normals=new Float32Array([
0,1,0,
0,1,0,
0,1,0,
0,1,0
]);
this.indices=new Uint16Array([0,1,2,0,2,3]);
this.computeBounds();
}
});
/* =========================
MATERIAL BASE
========================= */
const Material=__DEF("Material",class Material{
constructor(){
this.color=new Vec3(1,1,1);
this.emission=new Vec3(0,0,0);
this.roughness=0.5;
this.metallic=0;
}
});
/* =========================
LIGHT BASE
========================= */
const Light=__DEF("Light",class Light extends Object3D{
constructor(){
super();
this.color=new Vec3(1,1,1);
this.intensity=1;
}
});
/* =========================
POINT LIGHT
========================= */
const PointLight=__DEF("PointLight",class PointLight extends Light{
constructor(){
super();
this.range=10;
}
});
/* =========================
MESH OBJECT
========================= */
const Mesh=__DEF("Mesh",class Mesh extends Object3D{
constructor(geometry=null,material=null){
super();
this.geometry=geometry;
this.material=material;
}
});
/* =========================
SCENE RAYCAST SUPPORT
========================= */
Scene.prototype.raycast=function(ray){
let closest=new Hit();
for(const obj of this.objects){
if(!obj.geometry)continue;
let hit=this.intersectObject(ray,obj);
if(hit.hit&&hit.distance<closest.distance){
closest=hit;
}
}
return closest;
};
Scene.prototype.intersectObject=function(ray,obj){
let hit=new Hit();
let geom=obj.geometry;
if(geom instanceof SphereGeometry){
let center=obj.transform.position;
let oc=new Vec3(
ray.origin.x-center.x,
ray.origin.y-center.y,
ray.origin.z-center.z
);
let a=dot(ray.direction,ray.direction);
let b=2*dot(oc,ray.direction);
let c=dot(oc,oc)-1;
let d=b*b-4*a*c;
if(d>0){
let t=(-b-Math.sqrt(d))/(2*a);
if(t>0){
let pos=ray.at(t);
let normal=normalize(new Vec3(
pos.x-center.x,
pos.y-center.y,
pos.z-center.z
));
hit.set(pos,normal,t,obj);
}
}
}
return hit;
};
/* =========================
SPECTRAL CONVERTER
========================= */
const SpectralConverter=__DEF("SpectralConverter",class SpectralConverter{
constructor(){
this.CIE_X=[0.0014,0.0022,0.0042,0.0076,0.0143,0.0232,0.0435,0.0776,0.1344,0.2148,0.2839,0.3285,0.3483,0.3481,0.3362,0.3187,0.2908,0.2511,0.1954,0.1421,0.0956,0.058,0.032,0.0147,0.0049];
this.CIE_Y=[0,0.0001,0.0001,0.0002,0.0004,0.0006,0.0012,0.0022,0.004,0.0073,0.0116,0.0168,0.023,0.0298,0.038,0.048,0.06,0.0739,0.091,0.1126,0.139,0.1693,0.208,0.2586,0.323];
this.CIE_Z=[0.0065,0.0105,0.0201,0.0362,0.0679,0.1102,0.2074,0.3713,0.6456,1.0391,1.3856,1.623,1.7471,1.7826,1.7721,1.7441,1.6692,1.5281,1.2876,1.0419,0.813,0.6162,0.4652,0.3533,0.272];
}
toXYZ(spectral){
let X=0,Y=0,Z=0;
for(let i=0;i<spectral.samples.length;i++){
let s=spectral.samples[i];
let idx=Math.floor((s.lambda-380)/15);
if(idx>=0&&idx<this.CIE_X.length){
X+=this.CIE_X[idx]*s.intensity;
Y+=this.CIE_Y[idx]*s.intensity;
Z+=this.CIE_Z[idx]*s.intensity;
}
}
return new Vec3(X,Y,Z);
}
XYZtoRGB(xyz){
let r=xyz.x*3.2406+xyz.y*-1.5372+xyz.z*-0.4986;
let g=xyz.x*-0.9689+xyz.y*1.8758+xyz.z*0.0415;
let b=xyz.x*0.0557+xyz.y*-0.204+xyz.z*1.057;
return new Vec3(r,g,b);
}
spectralToRGB(spectral){
return this.XYZtoRGB(this.toXYZ(spectral));
}
});
/* =========================
BRDF CORE
========================= */
const BRDF=__DEF("BRDF",class BRDF{
static lambert(normal,lightDir,color){
let d=Math.max(dot(normal,lightDir),0);
return new Vec3(
color.x*d,
color.y*d,
color.z*d
);
}
static reflect(viewDir,normal,roughness){
let reflected=reflect(viewDir,normal);
let r=1-roughness;
return new Vec3(
reflected.x*r,
reflected.y*r,
reflected.z*r
);
}
});
/* =========================
PATH TRACING INTEGRATOR
========================= */
const PTIntegrator=__DEF("PTIntegrator",class PTIntegrator{
constructor(scene){
this.scene=scene;
this.maxDepth=4;
this.converter=new SpectralConverter();
}
trace(ray,depth=0){
if(depth>=this.maxDepth)return new Vec3();
let hit=this.scene.raycast(ray);
if(!hit.hit)return this.environment(ray);
let material=hit.object.material;
let color=new Vec3();
for(const light of this.scene.lights){
let lightDir=new Vec3(
light.transform.position.x-hit.position.x,
light.transform.position.y-hit.position.y,
light.transform.position.z-hit.position.z
);
lightDir.normalize();
let lambert=BRDF.lambert(hit.normal,lightDir,material.color);
color.add(lambert);
}
if(material.roughness<0.5){
let reflectDir=reflect(ray.direction,hit.normal);
let reflectRay=new Ray(hit.position,reflectDir);
let reflected=this.trace(reflectRay,depth+1);
color.add(reflected.mulScalar(0.5));
}
return color;
}
environment(ray){
let t=0.5*(ray.direction.y+1);
return new Vec3(
lerp(0.1,0.5,t),
lerp(0.1,0.6,t),
lerp(0.2,0.9,t)
);
}
});
/* =========================
HYBRID RENDER PIPELINE
========================= */
const HybridRenderer=__DEF("HybridRenderer",class HybridRenderer{
constructor(renderer){
this.renderer=renderer;
this.gl=renderer.gl;
this.integrator=new PTIntegrator(renderer.scene??new Scene());
this.framebuffer=null;
this.texture=null;
this.width=0;
this.height=0;
}
resize(w,h){
if(this.width===w&&this.height===h)return;
this.width=w;
this.height=h;
let gl=this.gl;
if(this.texture)gl.deleteTexture(this.texture);
this.texture=gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D,this.texture);
gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
}
render(scene,camera){
let gl=this.gl;
let w=this.renderer.canvas.width;
let h=this.renderer.canvas.height;
this.resize(w,h);
let pixels=new Uint8Array(w*h*4);
let ray=new Ray();
for(let y=0;y<h;y++){
for(let x=0;x<w;x++){
let u=(x/w)*2-1;
let v=(y/h)*2-1;
ray.origin.copy(camera.position);
ray.direction.set(u,v,-1).normalize();
let color=this.integrator.trace(ray,0);
let idx=(y*w+x)*4;
pixels[idx]=clamp(color.x*255,0,255);
pixels[idx+1]=clamp(color.y*255,0,255);
pixels[idx+2]=clamp(color.z*255,0,255);
pixels[idx+3]=255;
}
}
gl.bindTexture(gl.TEXTURE_2D,this.texture);
gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
}
});
/* =========================
RENDERER EXTENSION
========================= */
Renderer.prototype.enableHybrid=function(){
if(this.hybrid)return this.hybrid;
this.hybrid=new HybridRenderer(this);
AUTH.renderer.hybrid=this.hybrid;
return this.hybrid;
};
Renderer.prototype.renderHybrid=function(scene,camera){
if(!this.hybrid)this.enableHybrid();
this.hybrid.render(scene,camera);
};
/* =========================
ENGINE HYBRID SUPPORT
========================= */
Engine.prototype.enableHybrid=function(){
this.renderer.enableHybrid();
};
Engine.prototype.renderHybrid=function(){
__assertAuthority();
this.renderer.renderHybrid(this.scene,this.camera);
};

/* =========================
SHADER CORE
========================= */
const Shader=__DEF("Shader",class Shader{
constructor(gl,type,source){
this.gl=gl;
this.type=type;
this.source=source;
this.handle=this.compile();
}
compile(){
const gl=this.gl;
const shader=gl.createShader(this.type);
gl.shaderSource(shader,this.source);
gl.compileShader(shader);
if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){
const err=gl.getShaderInfoLog(shader);
gl.deleteShader(shader);
throw new Error("[Shader compile error] "+err);
}
return shader;
}
});
/* =========================
PROGRAM CORE
========================= */
const Program=__DEF("Program",class Program{
constructor(gl,vsSource,fsSource){
this.gl=gl;
this.vs=new Shader(gl,gl.VERTEX_SHADER,vsSource);
this.fs=new Shader(gl,gl.FRAGMENT_SHADER,fsSource);
this.handle=this.link();
this.uniforms=Object.create(null);
this.attribs=Object.create(null);
this.cacheLocations();
}
link(){
const gl=this.gl;
const program=gl.createProgram();
gl.attachShader(program,this.vs.handle);
gl.attachShader(program,this.fs.handle);
gl.linkProgram(program);
if(!gl.getProgramParameter(program,gl.LINK_STATUS)){
const err=gl.getProgramInfoLog(program);
gl.deleteProgram(program);
throw new Error("[Program link error] "+err);
}
return program;
}
cacheLocations(){
const gl=this.gl;
const program=this.handle;
const nUniforms=gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);
for(let i=0;i<nUniforms;i++){
const info=gl.getActiveUniform(program,i);
this.uniforms[info.name]=gl.getUniformLocation(program,info.name);
}
const nAttribs=gl.getProgramParameter(program,gl.ACTIVE_ATTRIBUTES);
for(let i=0;i<nAttribs;i++){
const info=gl.getActiveAttrib(program,i);
this.attribs[info.name]=gl.getAttribLocation(program,info.name);
}
}
use(){
this.gl.useProgram(this.handle);
}
});
/* =========================
SHADER LIBRARY
========================= */
const ShaderLib=__DEF("ShaderLib",class ShaderLib{
static basicVS(){
return `
attribute vec3 position;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat4 modelMatrix;
void main(){
gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.0);
}`;
}
static basicFS(){
return `
precision highp float;
uniform vec3 color;
void main(){
gl_FragColor=vec4(color,1.0);
}`;
}
static cinematicFS(){
return `
precision highp float;
uniform vec3 color;
uniform float time;
void main(){
float glow=sin(time)*0.5+0.5;
gl_FragColor=vec4(color*glow,1.0);
}`;
}
});
/* =========================
GPU BUFFER CORE
========================= */
const GLBuffer=__DEF("GLBuffer",class GLBuffer{
constructor(gl,target,data,usage){
this.gl=gl;
this.target=target;
this.handle=gl.createBuffer();
gl.bindBuffer(target,this.handle);
gl.bufferData(target,data,usage||gl.STATIC_DRAW);
}
bind(){
this.gl.bindBuffer(this.target,this.handle);
}
});
/* =========================
MESH GPU WRAPPER
========================= */
const GLMesh=__DEF("GLMesh",class GLMesh{
constructor(gl,geometry){
this.gl=gl;
this.geometry=geometry;
this.vertexBuffer=null;
this.normalBuffer=null;
this.indexBuffer=null;
this.upload();
}
upload(){
const gl=this.gl;
if(this.geometry.vertices){
this.vertexBuffer=new GLBuffer(gl,gl.ARRAY_BUFFER,this.geometry.vertices);
}
if(this.geometry.normals){
this.normalBuffer=new GLBuffer(gl,gl.ARRAY_BUFFER,this.geometry.normals);
}
if(this.geometry.indices){
this.indexBuffer=new GLBuffer(gl,gl.ELEMENT_ARRAY_BUFFER,this.geometry.indices);
}
}
draw(program){
const gl=this.gl;
if(this.vertexBuffer){
this.vertexBuffer.bind();
const loc=program.attribs.position;
if(loc>=0){
gl.enableVertexAttribArray(loc);
gl.vertexAttribPointer(loc,3,gl.FLOAT,false,0,0);
}
}
if(this.indexBuffer){
this.indexBuffer.bind();
gl.drawElements(gl.TRIANGLES,this.geometry.indices.length,gl.UNSIGNED_SHORT,0);
}else{
gl.drawArrays(gl.TRIANGLES,0,this.geometry.vertices.length/3);
}
}
});
/* =========================
RENDER PIPELINE
========================= */
const RenderPipeline=__DEF("RenderPipeline",class RenderPipeline{
constructor(renderer){
this.renderer=renderer;
this.gl=renderer.gl;
this.program=null;
this.meshCache=new WeakMap();
this.time=0;
this.init();
}
init(){
const gl=this.gl;
this.program=new Program(
gl,
ShaderLib.basicVS(),
ShaderLib.cinematicFS()
);
}
getMesh(geometry){
let mesh=this.meshCache.get(geometry);
if(mesh)return mesh;
mesh=new GLMesh(this.gl,geometry);
this.meshCache.set(geometry,mesh);
return mesh;
}
render(scene,camera){
const gl=this.gl;
this.time+=this.renderer.runtime.delta;
this.program.use();
gl.uniform3f(this.program.uniforms.color,1,1,1);
gl.uniform1f(this.program.uniforms.time,this.time);
for(const obj of scene.objects){
if(!obj.visible||!obj.geometry)continue;
const mesh=this.getMesh(obj.geometry);
mesh.draw(this.program);
}
}
});
/* =========================
RENDERER PIPELINE ENABLE
========================= */
Renderer.prototype.enablePipeline=function(){
if(this.pipeline)return this.pipeline;
this.pipeline=new RenderPipeline(this);
AUTH.renderer.pipeline=this.pipeline;
return this.pipeline;
};
Renderer.prototype.renderPipeline=function(scene,camera){
if(!this.pipeline)this.enablePipeline();
this.pipeline.render(scene,camera);
};
/* =========================
ENGINE PIPELINE SUPPORT
========================= */
Engine.prototype.enablePipeline=function(){
this.renderer.enablePipeline();
};
Engine.prototype.renderPipeline=function(){
__assertAuthority();
this.renderer.renderPipeline(this.scene,this.camera);
};

/* =========================
CINEMATIC CAMERA EXTENSION
========================= */
const CinematicCamera=__DEF("CinematicCamera",class CinematicCamera extends Camera{
constructor(){
super();
this.aperture=0.0;
this.focusDistance=10.0;
this.shutterSpeed=1/60;
this.iso=100;
this.exposure=1.0;
this.jitter=new Vec3();
this.prevViewMatrix=new Float32Array(16);
this.currViewMatrix=new Float32Array(16);
}
updateExposure(){
const ev100=Math.log2((this.aperture*this.aperture)/this.shutterSpeed*100/this.iso);
this.exposure=1/Math.pow(2,ev100);
}
applyJitter(frame){
const x=((frame*16807)%2147483647)/2147483647;
const y=((frame*48271)%2147483647)/2147483647;
this.jitter.set(x-0.5,y-0.5,0);
}
});
/* =========================
TEMPORAL FRAME BUFFER
========================= */
const TemporalBuffer=__DEF("TemporalBuffer",class TemporalBuffer{
constructor(gl,width,height){
this.gl=gl;
this.width=width;
this.height=height;
this.frame=0;
this.texture=this.createTexture();
this.historyTexture=this.createTexture();
}
createTexture(){
const gl=this.gl;
const tex=gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D,tex);
gl.texImage2D(
gl.TEXTURE_2D,
0,
gl.RGBA,
this.width,
this.height,
0,
gl.RGBA,
gl.UNSIGNED_BYTE,
null
);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
return tex;
}
swap(){
let t=this.texture;
this.texture=this.historyTexture;
this.historyTexture=t;
this.frame++;
}
});
/* =========================
TEMPORAL SYSTEM
========================= */
const TemporalSystem=__DEF("TemporalSystem",class TemporalSystem{
constructor(renderer){
this.renderer=renderer;
this.gl=renderer.gl;
this.buffer=null;
this.enabled=true;
}
initialize(){
const gl=this.gl;
const w=this.renderer.canvas.width;
const h=this.renderer.canvas.height;
this.buffer=new TemporalBuffer(gl,w,h);
AUTH.renderer.temporal=this;
}
resize(){
if(!this.buffer)return;
const w=this.renderer.canvas.width;
const h=this.renderer.canvas.height;
if(this.buffer.width!==w||this.buffer.height!==h){
this.buffer=new TemporalBuffer(this.gl,w,h);
}
}
accumulate(){
if(!this.enabled||!this.buffer)return;
this.buffer.swap();
}
});
/* =========================
RENDERER TEMPORAL EXTENSION
========================= */
Renderer.prototype.enableTemporal=function(){
if(this.temporalSystem)return this.temporalSystem;
this.temporalSystem=new TemporalSystem(this);
this.temporalSystem.initialize();
return this.temporalSystem;
};
Renderer.prototype.updateTemporal=function(){
if(!this.temporalSystem)return;
this.temporalSystem.resize();
this.temporalSystem.accumulate();
};
/* =========================
ENGINE TEMPORAL SUPPORT
========================= */
Engine.prototype.enableTemporal=function(){
this.renderer.enableTemporal();
};
Engine.prototype.updateTemporal=function(){
this.renderer.updateTemporal();
};
/* =========================
FRAME ACCUMULATION SYSTEM
========================= */
const FrameAccumulator=__DEF("FrameAccumulator",class FrameAccumulator{
constructor(){
this.samples=0;
this.maxSamples=1024;
this.accumulated=false;
}
reset(){
this.samples=0;
this.accumulated=false;
}
addSample(){
this.samples++;
if(this.samples>=this.maxSamples){
this.accumulated=true;
}
}
});
/* =========================
RENDER LOOP EXTENSION
========================= */
Engine.prototype.start=function(){
const loop=()=>{
this.render();
this.updateTemporal?.();
requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
};
/* =========================
CINEMATIC MOTION BLUR CORE
========================= */
const MotionBlur=__DEF("MotionBlur",class MotionBlur{
constructor(renderer){
this.renderer=renderer;
this.enabled=true;
this.intensity=0.9;
}
apply(){
if(!this.enabled)return;
}
});
Renderer.prototype.enableMotionBlur=function(){
if(this.motionBlur)return this.motionBlur;
this.motionBlur=new MotionBlur(this);
AUTH.renderer.motionBlur=this.motionBlur;
return this.motionBlur;
};

/* =========================
REFLECTION PROBE
========================= */
const ReflectionProbe=__DEF("ReflectionProbe",class ReflectionProbe{
constructor(position=new Vec3(),size=10){
this.position=position.clone();
this.size=size;
this.cubemap=null;
this.dirty=true;
}
});
/* =========================
REFLECTION SYSTEM
========================= */
const ReflectionSystem=__DEF("ReflectionSystem",class ReflectionSystem{
constructor(renderer){
this.renderer=renderer;
this.gl=renderer.gl;
this.probes=[];
this.enabled=true;
}
initialize(){
AUTH.renderer.reflection=this;
}
addProbe(probe){
this.probes.push(probe);
}
update(){
if(!this.enabled)return;
for(const probe of this.probes){
if(probe.dirty){
this.captureProbe(probe);
probe.dirty=false;
}
}
}
captureProbe(probe){
const gl=this.gl;
probe.cubemap=gl.createTexture();
}
});
/* =========================
RENDERER REFLECTION EXTENSION
========================= */
Renderer.prototype.enableReflection=function(){
if(this.reflectionSystem)return this.reflectionSystem;
this.reflectionSystem=new ReflectionSystem(this);
this.reflectionSystem.initialize();
return this.reflectionSystem;
};
Renderer.prototype.updateReflection=function(){
if(!this.reflectionSystem)return;
this.reflectionSystem.update();
};
/* =========================
ENGINE REFLECTION SUPPORT
========================= */
Engine.prototype.enableReflection=function(){
this.renderer.enableReflection();
};
Engine.prototype.updateReflection=function(){
this.renderer.updateReflection();
};
/* =========================
GLOBAL ILLUMINATION CORE
========================= */
const GIProbe=__DEF("GIProbe",class GIProbe{
constructor(position=new Vec3()){
this.position=position.clone();
this.irradiance=new Vec3();
this.dirty=true;
}
});
const GISystem=__DEF("GISystem",class GISystem{
constructor(renderer){
this.renderer=renderer;
this.probes=[];
this.enabled=true;
}
initialize(){
AUTH.renderer.gi=this;
}
addProbe(probe){
this.probes.push(probe);
}
update(scene){
if(!this.enabled)return;
for(const probe of this.probes){
if(probe.dirty){
this.computeIrradiance(scene,probe);
probe.dirty=false;
}
}
}
computeIrradiance(scene,probe){
let color=new Vec3();
for(const light of scene.lights){
let dx=light.transform.position.x-probe.position.x;
let dy=light.transform.position.y-probe.position.y;
let dz=light.transform.position.z-probe.position.z;
let dist=Math.sqrt(dx*dx+dy*dy+dz*dz);
let intensity=light.intensity/(dist*dist+0.001);
color.x+=light.color.x*intensity;
color.y+=light.color.y*intensity;
color.z+=light.color.z*intensity;
}
probe.irradiance=color;
}
});
/* =========================
RENDERER GI EXTENSION
========================= */
Renderer.prototype.enableGI=function(){
if(this.giSystem)return this.giSystem;
this.giSystem=new GISystem(this);
this.giSystem.initialize();
return this.giSystem;
};
Renderer.prototype.updateGI=function(scene){
if(!this.giSystem)return;
this.giSystem.update(scene);
};
/* =========================
ENGINE GI SUPPORT
========================= */
Engine.prototype.enableGI=function(){
this.renderer.enableGI();
};
Engine.prototype.updateGI=function(){
this.renderer.updateGI(this.scene);
};
/* =========================
LIGHT TRANSPORT CORE
========================= */
const LightTransport=__DEF("LightTransport",class LightTransport{
constructor(scene){
this.scene=scene;
}
propagate(){
for(const obj of this.scene.objects){
if(!obj.material)continue;
let emission=obj.material.emission;
if(emission.x>0||emission.y>0||emission.z>0){
this.propagateEmission(obj);
}
}
}
propagateEmission(source){
for(const obj of this.scene.objects){
if(obj===source)continue;
let dx=obj.transform.position.x-source.transform.position.x;
let dy=obj.transform.position.y-source.transform.position.y;
let dz=obj.transform.position.z-source.transform.position.z;
let dist=Math.sqrt(dx*dx+dy*dy+dz*dz);
let factor=1/(dist*dist+0.001);
obj.material.color.x+=source.material.emission.x*factor;
obj.material.color.y+=source.material.emission.y*factor;
obj.material.color.z+=source.material.emission.z*factor;
}
}
});
/* =========================
ENGINE LIGHT TRANSPORT SUPPORT
========================= */
Engine.prototype.enableLightTransport=function(){
if(this.lightTransport)return this.lightTransport;
this.lightTransport=new LightTransport(this.scene);
return this.lightTransport;
};
Engine.prototype.updateLightTransport=function(){
if(!this.lightTransport)return;
this.lightTransport.propagate();
};
/* =========================
RENDER LOOP EXTENSION
========================= */
Engine.prototype.render=function(){
__assertAuthority();
this.renderer.render(this.scene,this.camera);
this.renderer.updateTemporal?.();
this.renderer.updateReflection?.();
this.renderer.updateGI?.(this.scene);
this.updateLightTransport?.();
};

/* =========================
POST PROCESS PASS BASE
========================= */
const PostProcessPass=__DEF("PostProcessPass",class PostProcessPass{
constructor(renderer){
this.renderer=renderer;
this.gl=renderer.gl;
this.enabled=true;
}
apply(inputTexture,outputFramebuffer){}
});
/* =========================
FRAMEBUFFER CORE
========================= */
const Framebuffer=__DEF("Framebuffer",class Framebuffer{
constructor(gl,width,height){
this.gl=gl;
this.width=width;
this.height=height;
this.framebuffer=gl.createFramebuffer();
this.texture=this.createTexture();
this.bind();
gl.framebufferTexture2D(
gl.FRAMEBUFFER,
gl.COLOR_ATTACHMENT0,
gl.TEXTURE_2D,
this.texture,
0
);
this.unbind();
}
createTexture(){
const gl=this.gl;
const tex=gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D,tex);
gl.texImage2D(
gl.TEXTURE_2D,
0,
gl.RGBA,
this.width,
this.height,
0,
gl.RGBA,
gl.UNSIGNED_BYTE,
null
);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
return tex;
}
bind(){
this.gl.bindFramebuffer(this.gl.FRAMEBUFFER,this.framebuffer);
}
unbind(){
this.gl.bindFramebuffer(this.gl.FRAMEBUFFER,null);
}
});
/* =========================
BLOOM PASS
========================= */
const BloomPass=__DEF("BloomPass",class BloomPass extends PostProcessPass{
constructor(renderer){
super(renderer);
this.threshold=1.0;
this.intensity=1.2;
}
apply(inputTexture){
if(!this.enabled)return inputTexture;
return inputTexture;
}
});
/* =========================
TONE MAPPING PASS
========================= */
const ToneMappingPass=__DEF("ToneMappingPass",class ToneMappingPass extends PostProcessPass{
constructor(renderer){
super(renderer);
this.exposure=1.0;
}
apply(inputTexture){
if(!this.enabled)return inputTexture;
return inputTexture;
}
});
/* =========================
COLOR GRADING PASS
========================= */
const ColorGradingPass=__DEF("ColorGradingPass",class ColorGradingPass extends PostProcessPass{
constructor(renderer){
super(renderer);
this.lut=null;
this.intensity=1.0;
}
apply(inputTexture){
if(!this.enabled)return inputTexture;
return inputTexture;
}
});
/* =========================
POST PROCESS PIPELINE
========================= */
const PostProcessPipeline=__DEF("PostProcessPipeline",class PostProcessPipeline{
constructor(renderer){
this.renderer=renderer;
this.gl=renderer.gl;
this.passes=[];
this.framebuffer=null;
this.width=0;
this.height=0;
this.init();
}
init(){
this.addPass(new BloomPass(this.renderer));
this.addPass(new ToneMappingPass(this.renderer));
this.addPass(new ColorGradingPass(this.renderer));
}
addPass(pass){
this.passes.push(pass);
}
resize(width,height){
if(this.width===width&&this.height===height)return;
this.width=width;
this.height=height;
this.framebuffer=new Framebuffer(this.gl,width,height);
}
render(inputTexture){
let texture=inputTexture;
for(const pass of this.passes){
if(pass.enabled){
texture=pass.apply(texture);
}
}
return texture;
}
});
/* =========================
RENDERER POST PROCESS EXTENSION
========================= */
Renderer.prototype.enablePostProcessing=function(){
if(this.postProcess)return this.postProcess;
this.postProcess=new PostProcessPipeline(this);
AUTH.renderer.postProcess=this.postProcess;
return this.postProcess;
};
Renderer.prototype.renderPost=function(inputTexture){
if(!this.postProcess)this.enablePostProcessing();
return this.postProcess.render(inputTexture);
};
/* =========================
ENGINE POST PROCESS SUPPORT
========================= */
Engine.prototype.enablePostProcessing=function(){
this.renderer.enablePostProcessing();
};
/* =========================
CINEMATIC TONE MAPPER
========================= */
const ToneMapper=__DEF("ToneMapper",class ToneMapper{
constructor(){
this.exposure=1.0;
this.gamma=2.2;
}
apply(color){
color.x=1-Math.exp(-color.x*this.exposure);
color.y=1-Math.exp(-color.y*this.exposure);
color.z=1-Math.exp(-color.z*this.exposure);
color.x=Math.pow(color.x,1/this.gamma);
color.y=Math.pow(color.y,1/this.gamma);
color.z=Math.pow(color.z,1/this.gamma);
return color;
}
});
/* =========================
COLOR GRADER
========================= */
const ColorGrader=__DEF("ColorGrader",class ColorGrader{
constructor(){
this.saturation=1.0;
this.contrast=1.0;
}
apply(color){
let avg=(color.x+color.y+color.z)/3;
color.x=avg+(color.x-avg)*this.saturation;
color.y=avg+(color.y-avg)*this.saturation;
color.z=avg+(color.z-avg)*this.saturation;
color.x=(color.x-0.5)*this.contrast+0.5;
color.y=(color.y-0.5)*this.contrast+0.5;
color.z=(color.z-0.5)*this.contrast+0.5;
return color;
}
});
/* =========================
ENGINE COLOR PIPELINE SUPPORT
========================= */
Engine.prototype.enableColorPipeline=function(){
if(this.toneMapper)return;
this.toneMapper=new ToneMapper();
this.colorGrader=new ColorGrader();
};
Engine.prototype.applyColorPipeline=function(color){
if(this.toneMapper)color=this.toneMapper.apply(color);
if(this.colorGrader)color=this.colorGrader.apply(color);
return color;
};

/* =========================
PARTICLE CORE
========================= */
const Particle=__DEF("Particle",class Particle{
constructor(){
this.position=new Vec3();
this.velocity=new Vec3();
this.life=0;
this.maxLife=1;
this.size=1;
this.color=new Vec3(1,1,1);
this.active=false;
}
reset(position,velocity,life,size,color){
this.position.copy(position);
this.velocity.copy(velocity);
this.life=life;
this.maxLife=life;
this.size=size;
this.color.copy(color);
this.active=true;
}
update(dt){
if(!this.active)return;
this.life-=dt;
if(this.life<=0){
this.active=false;
return;
}
this.position.add(this.velocity.clone().mulScalar(dt));
}
});
/* =========================
PARTICLE SYSTEM
========================= */
const ParticleSystem=__DEF("ParticleSystem",class ParticleSystem{
constructor(maxParticles=1024){
this.particles=new Array(maxParticles);
this.maxParticles=maxParticles;
this.gravity=new Vec3(0,-9.8,0);
this.emissionRate=10;
this.time=0;
for(let i=0;i<maxParticles;i++){
this.particles[i]=new Particle();
}
}
emit(position,velocity,life=1,size=1,color=new Vec3(1,1,1)){
for(const p of this.particles){
if(!p.active){
p.reset(position,velocity,life,size,color);
break;
}
}
}
update(dt){
this.time+=dt;
for(const p of this.particles){
if(p.active){
p.velocity.add(this.gravity.clone().mulScalar(dt));
p.update(dt);
}
}
}
});
/* =========================
RENDERER PARTICLE EXTENSION
========================= */
Renderer.prototype.enableParticles=function(){
if(this.particleSystems)return this.particleSystems;
this.particleSystems=[];
AUTH.renderer.particles=this.particleSystems;
return this.particleSystems;
};
Renderer.prototype.addParticleSystem=function(system){
if(!this.particleSystems)this.enableParticles();
this.particleSystems.push(system);
};
Renderer.prototype.updateParticles=function(){
if(!this.particleSystems)return;
const dt=this.runtime.delta;
for(const ps of this.particleSystems){
ps.update(dt);
}
};
/* =========================
ENGINE PARTICLE SUPPORT
========================= */
Engine.prototype.enableParticles=function(){
this.renderer.enableParticles();
};
Engine.prototype.addParticleSystem=function(system){
this.renderer.addParticleSystem(system);
};
/* =========================
VOLUMETRIC LIGHT CORE
========================= */
const VolumetricLight=__DEF("VolumetricLight",class VolumetricLight{
constructor(position=new Vec3(),color=new Vec3(1,1,1),intensity=1){
this.position=position.clone();
this.color=color.clone();
this.intensity=intensity;
this.scattering=0.5;
}
compute(point){
let dx=point.x-this.position.x;
let dy=point.y-this.position.y;
let dz=point.z-this.position.z;
let dist=Math.sqrt(dx*dx+dy*dy+dz*dz);
let atten=this.intensity/(dist*dist+1);
return new Vec3(
this.color.x*atten*this.scattering,
this.color.y*atten*this.scattering,
this.color.z*atten*this.scattering
);
}
});
/* =========================
VOLUMETRIC SYSTEM
========================= */
const VolumetricSystem=__DEF("VolumetricSystem",class VolumetricSystem{
constructor(renderer){
this.renderer=renderer;
this.lights=[];
this.enabled=true;
}
addLight(light){
this.lights.push(light);
}
compute(scene){
if(!this.enabled)return;
for(const obj of scene.objects){
let accum=new Vec3();
for(const light of this.lights){
accum.add(light.compute(obj.transform.position));
}
if(obj.material){
obj.material.color.add(accum);
}
}
}
});
/* =========================
RENDERER VOLUMETRIC EXTENSION
========================= */
Renderer.prototype.enableVolumetric=function(){
if(this.volumetricSystem)return this.volumetricSystem;
this.volumetricSystem=new VolumetricSystem(this);
AUTH.renderer.volumetric=this.volumetricSystem;
return this.volumetricSystem;
};
Renderer.prototype.updateVolumetric=function(scene){
if(!this.volumetricSystem)return;
this.volumetricSystem.compute(scene);
};
/* =========================
ENGINE VOLUMETRIC SUPPORT
========================= */
Engine.prototype.enableVolumetric=function(){
this.renderer.enableVolumetric();
};
Engine.prototype.updateVolumetric=function(){
this.renderer.updateVolumetric(this.scene);
};
/* =========================
ATMOSPHERIC SCATTERING CORE
========================= */
const Atmosphere=__DEF("Atmosphere",class Atmosphere{
constructor(){
this.density=0.5;
this.color=new Vec3(0.5,0.6,0.7);
}
scatter(ray){
let t=0.5*(ray.direction.y+1);
return new Vec3(
this.color.x*t*this.density,
this.color.y*t*this.density,
this.color.z*t*this.density
);
}
});
/* =========================
RENDERER ATMOSPHERE EXTENSION
========================= */
Renderer.prototype.enableAtmosphere=function(){
if(this.atmosphere)return this.atmosphere;
this.atmosphere=new Atmosphere();
AUTH.renderer.atmosphere=this.atmosphere;
return this.atmosphere;
};

/* =========================
ANIMATION CLIP
========================= */
const AnimationClip=__DEF("AnimationClip",class AnimationClip{
constructor(duration=1){
this.duration=duration;
this.tracks=[];
}
addTrack(track){
this.tracks.push(track);
}
});
/* =========================
ANIMATION TRACK
========================= */
const AnimationTrack=__DEF("AnimationTrack",class AnimationTrack{
constructor(target,property){
this.target=target;
this.property=property;
this.keys=[];
}
addKey(time,value){
this.keys.push({time,value});
}
evaluate(time){
if(this.keys.length===0)return;
let prev=this.keys[0];
let next=this.keys[this.keys.length-1];
for(let i=0;i<this.keys.length-1;i++){
if(time>=this.keys[i].time&&time<=this.keys[i+1].time){
prev=this.keys[i];
next=this.keys[i+1];
break;
}
}
let t=(time-prev.time)/(next.time-prev.time||1);
let v=lerp(prev.value,next.value,t);
this.target[this.property]=v;
}
});
/* =========================
ANIMATION SYSTEM
========================= */
const AnimationSystem=__DEF("AnimationSystem",class AnimationSystem{
constructor(){
this.clips=[];
this.time=0;
this.playing=true;
}
addClip(clip){
this.clips.push(clip);
}
update(dt){
if(!this.playing)return;
this.time+=dt;
for(const clip of this.clips){
let t=this.time%clip.duration;
for(const track of clip.tracks){
track.evaluate(t);
}
}
}
});
/* =========================
RENDERER ANIMATION EXTENSION
========================= */
Renderer.prototype.enableAnimation=function(){
if(this.animationSystem)return this.animationSystem;
this.animationSystem=new AnimationSystem();
AUTH.renderer.animation=this.animationSystem;
return this.animationSystem;
};
Renderer.prototype.updateAnimation=function(){
if(!this.animationSystem)return;
this.animationSystem.update(this.runtime.delta);
};
/* =========================
ENGINE ANIMATION SUPPORT
========================= */
Engine.prototype.enableAnimation=function(){
this.renderer.enableAnimation();
};
Engine.prototype.updateAnimation=function(){
this.renderer.updateAnimation();
};
/* =========================
ASSET LOADER CORE
========================= */
const AssetLoader=__DEF("AssetLoader",class AssetLoader{
constructor(){
this.cache=new Map();
}
async loadText(url){
if(this.cache.has(url))return this.cache.get(url);
let res=await fetch(url);
let text=await res.text();
this.cache.set(url,text);
return text;
}
async loadJSON(url){
if(this.cache.has(url))return this.cache.get(url);
let res=await fetch(url);
let json=await res.json();
this.cache.set(url,json);
return json;
}
async loadImage(url){
if(this.cache.has(url))return this.cache.get(url);
return new Promise(resolve=>{
let img=new Image();
img.onload=()=>{
this.cache.set(url,img);
resolve(img);
};
img.src=url;
});
}
});
/* =========================
ENGINE LOADER SUPPORT
========================= */
Engine.prototype.enableLoader=function(){
if(this.loader)return this.loader;
this.loader=new AssetLoader();
return this.loader;
};
/* =========================
TASK SCHEDULER
========================= */
const TaskScheduler=__DEF("TaskScheduler",class TaskScheduler{
constructor(){
this.tasks=[];
}
add(task){
this.tasks.push(task);
}
run(){
for(const task of this.tasks){
task();
}
}
});
/* =========================
ENGINE TASK SUPPORT
========================= */
Engine.prototype.enableScheduler=function(){
if(this.scheduler)return this.scheduler;
this.scheduler=new TaskScheduler();
return this.scheduler;
};
Engine.prototype.schedule=function(task){
if(!this.scheduler)this.enableScheduler();
this.scheduler.add(task);
};
/* =========================
ENGINE UPDATE ORCHESTRATION
========================= */
Engine.prototype.update=function(){
const dt=this.renderer.runtime.delta;
this.renderer.updateAnimation?.();
this.renderer.updateParticles?.();
this.renderer.updateReflection?.();
this.renderer.updateGI?.(this.scene);
this.renderer.updateVolumetric?.(this.scene);
this.scheduler?.run();
};
/* =========================
MAIN ENGINE LOOP
========================= */
Engine.prototype.start=function(){
const loop=()=>{
this.renderer.runtime.tick();
this.update();
this.render();
requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
};

/* =========================
ENGINE BOOTSTRAP SYSTEM
========================= */
const EngineBootstrap=__DEF("EngineBootstrap",class EngineBootstrap{
constructor(){
this.initialized=false;
}
init(engine){
if(this.initialized)return;
this.engine=engine;
this.bindSystems();
this.initialized=true;
}
bindSystems(){
const renderer=this.engine.renderer;
/* bind temporal */
if(renderer.temporalSystem){
AUTH.renderer.temporal=renderer.temporalSystem;
}
/* bind reflection */
if(renderer.reflectionSystem){
AUTH.renderer.reflection=renderer.reflectionSystem;
}
/* bind GI */
if(renderer.giSystem){
AUTH.renderer.gi=renderer.giSystem;
}
/* bind volumetric */
if(renderer.volumetricSystem){
AUTH.renderer.volumetric=renderer.volumetricSystem;
}
/* bind pipeline */
if(renderer.pipeline){
AUTH.renderer.pipeline=renderer.pipeline;
}
/* bind hybrid */
if(renderer.hybrid){
AUTH.renderer.hybrid=renderer.hybrid;
}
/* bind particles */
if(renderer.particleSystems){
AUTH.renderer.particles=renderer.particleSystems;
}
/* bind animation */
if(renderer.animationSystem){
AUTH.renderer.animation=renderer.animationSystem;
}
/* bind post process */
if(renderer.postProcess){
AUTH.renderer.postProcess=renderer.postProcess;
}
/* bind atmosphere */
if(renderer.atmosphere){
AUTH.renderer.atmosphere=renderer.atmosphere;
}
}
});
/* =========================
GLOBAL ENGINE FACTORY
========================= */
const EngineFactory=__DEF("EngineFactory",class EngineFactory{
static create(canvas){
const engine=new Engine(canvas);
engine.bootstrap=new EngineBootstrap();
engine.bootstrap.init(engine);
return engine;
}
});
/* =========================
ENGINE INTEGRITY CHECK
========================= */
const Integrity=__DEF("Integrity",class Integrity{
static verify(){
if(!AUTH)throw new Error("[KUROMI] AUTH missing");
if(!AUTH.renderer)throw new Error("[KUROMI] renderer missing");
if(!AUTH.runtime)throw new Error("[KUROMI] runtime missing");
}
static lock(){
__lockAuthority();
}
});
/* =========================
SAFE INITIALIZATION WRAPPER
========================= */
Engine.prototype.initialize=function(){
if(this.__initialized)return;
Integrity.verify();
Integrity.lock();
this.__initialized=true;
};
/* =========================
SAFE RENDER WRAPPER
========================= */
Engine.prototype.safeRender=function(){
if(!this.__initialized)this.initialize();
this.render();
};
/* =========================
SAFE START WRAPPER
========================= */
Engine.prototype.safeStart=function(){
if(!this.__initialized)this.initialize();
this.start();
};
/* =========================
GLOBAL EXPORT EXTENSION
========================= */
Object.assign(globalThis.KUROMI,{
EngineFactory,
Integrity,
ParticleSystem,
ReflectionProbe,
GIProbe,
VolumetricLight,
AnimationClip,
AnimationTrack,
AssetLoader,
TaskScheduler,
PostProcessPipeline,
ToneMapper,
ColorGrader,
Atmosphere
});
/* =========================
FINAL AUTHORITY LOCK
========================= */
Integrity.lock();
/* =========================
FINAL SAFETY FREEZE
========================= */
__freeze(globalThis.KUROMI);
/* =========================
FINAL BOOT COMPLETE FLAG
========================= */
globalThis.__KUROMI_READY=true;
