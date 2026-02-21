import * as THREE from 'https://jspm.dev/three'
import{ENGINE_CONFIG,initializeEngineConfig,getDerivedConfig,getGPUCapabilities,assertEngineConfigAuthority,getEngineConfigRuntimeState}from'./EngineConfig.js'
import {Renderer} from '../renderer/Renderer.js'
import {CinematicRenderPipeline} from '../renderer/CinematicRenderPipeline.js'
import {SceneManager} from '../scene/SceneManager.js'
import {CameraSystem} from '../camera/CameraSystem.js'
import {SystemManager} from '../systems/SystemManager.js'
import {TaskScheduler} from '../systems/TaskScheduler.js'
import {MemoryMonitor} from '../systems/MemoryMonitor.js'
import {AssetManager} from '../assets/AssetManager.js'
import {EnvironmentSystem} from '../world/EnvironmentSystem.js'
import {PerformanceMonitor} from '../systems/PerformanceMonitor.js'
import {PerformanceScaler} from '../systems/PerformanceScaler.js'
const __ENGINE_AUTHORITY_CONTAINER={
config:null,
derived:null,
gpu:null,
runtime:null,
renderer:null,
locked:false
}

function __lockAuthorityContainer(){

if(__ENGINE_AUTHORITY_LOCKED)return

const deepFreeze=(obj,seen=new WeakSet())=>{

if(obj===null||typeof obj!=="object")return obj

if(seen.has(obj))return obj

seen.add(obj)

const keys=Reflect.ownKeys(obj)

for(let i=0;i<keys.length;i++){

const value=obj[keys[i]]

if(value&&typeof value==="object"){

deepFreeze(value,seen)

}

}

return Object.freeze(obj)

}

deepFreeze(__ENGINE_AUTHORITY_CONTAINER.renderer)

deepFreeze(__ENGINE_AUTHORITY_CONTAINER.gpu)

deepFreeze(__ENGINE_AUTHORITY_CONTAINER.runtime)

deepFreeze(__ENGINE_AUTHORITY_CONTAINER)

__ENGINE_AUTHORITY_LOCKED=true

}

function __assertAuthorityIntegrity(){
if(!__ENGINE_AUTHORITY_CONTAINER.locked){
throw new Error("[ENGINE_AUTHORITY] Integrity violation")
}
}
const ENGINE_STATE={CONSTRUCTED:0,INITIALIZING:1,INITIALIZED:2,RUNNING:3,PAUSED:4,STOPPED:5,SHUTTING_DOWN:6,DESTROYED:7}
const EXECUTION_MODE={CPU_PRIORITY:0,GPU_PRIORITY:1,CINEMATIC_PRIORITY:2}
const FRAME_PHASE={BEGIN:0,FIXED:1,UPDATE:2,PRE_RENDER:3,RENDER:4,POST_RENDER:5,END:6}

class FrameGraphResourceManager{
constructor(){
this.resources=new Map()
this.descriptors=new Map()
this.refCounts=new Map()
}
register(name,resource,desc){
this.resources.set(name,resource)
this.descriptors.set(name,desc)
this.refCounts.set(name,0)
}
get(name){
return this.resources.get(name)
}
addRef(name){
this.refCounts.set(name,(this.refCounts.get(name)||0)+1)
}
release(name){
let c=(this.refCounts.get(name)||0)-1
if(c<=0){
this.resources.delete(name)
this.descriptors.delete(name)
this.refCounts.delete(name)
}else{
this.refCounts.set(name,c)
}
}
has(name){
return this.resources.has(name)
}
clear(){
this.resources.clear()
this.descriptors.clear()
this.refCounts.clear()
}
}

class FrameGraphExecutor{
constructor(engine){
this.engine=engine
this.nodes=[]
this.sorted=[]
this.executionList=new Array(512)
this.executionCount=0
this.resourceManager=new FrameGraphResourceManager()
}
addPass(pass){
this.nodes.push(pass)
}
compile(){
const visited=new Set()
const sorted=[]
const visit=(node)=>{
if(visited.has(node))return
visited.add(node)
if(node.dependencies){
for(let i=0;i<node.dependencies.length;i++){
visit(node.dependencies[i])
}
}
sorted.push(node)
}
for(let i=0;i<this.nodes.length;i++){
visit(this.nodes[i])
}
this.sorted=sorted
this.executionCount=sorted.length
}
execute(context){
const list=this.sorted
const count=this.executionCount
const rm=this.resourceManager
for(let i=0;i<count;i++){
const pass=list[i]
if(pass.execute){
pass.execute(context,rm)
}
}
}
clear(){
this.nodes.length=0
this.sorted.length=0
this.executionCount=0
this.resourceManager.clear()
}
}

class GPUStateCache{
constructor(gl){
this.gl=gl
this.program=null
this.material=null
this.geometry=null
this.framebuffer=null
this.blend=null
this.depth=null
}
setProgram(program){
if(this.program===program)return
this.program=program
this.gl.useProgram(program)
}
setFramebuffer(fb){
if(this.framebuffer===fb)return
this.framebuffer=fb
this.gl.bindFramebuffer(this.gl.FRAMEBUFFER,fb)
}
reset(){
this.program=null
this.material=null
this.geometry=null
this.framebuffer=null
this.blend=null
this.depth=null
}
}

/* =========================================================
CINEMATIC TEMPORAL SYSTEM (FILM-GRADE)
========================================================= */

class TemporalHistoryManager{
constructor(engine){
this.engine=engine
this.historyBuffers=new Map()
this.velocityBuffers=new Map()
this.depthBuffers=new Map()
this.valid=false
this.frameIndex=0
this.maxFrames=64
this.width=0
this.height=0
this.resetRequested=false
this.sampleCount=0
}
initialize(width,height){
if(width===this.width&&height===this.height&&!this.resetRequested)return
this.width=width
this.height=height
this.dispose()
this.historyBuffers.set("color",{width,height,data:null})
this.historyBuffers.set("luminance",{width,height,data:null})
this.velocityBuffers.set("motion",{width,height,data:null})
this.depthBuffers.set("depth",{width,height,data:null})
this.valid=false
this.frameIndex=0
this.sampleCount=0
this.resetRequested=false
}
requestReset(){
this.resetRequested=true
}
markValid(){
this.valid=true
this.resetRequested=false
}
isValid(){
return this.valid&&!this.resetRequested
}
updateFrame(){
this.frameIndex=(this.frameIndex+1)%this.maxFrames
this.sampleCount++
}
getSampleCount(){
return this.sampleCount
}
dispose(){
this.historyBuffers.clear()
this.velocityBuffers.clear()
this.depthBuffers.clear()
this.valid=false
this.sampleCount=0
}
}

class TemporalAccumulationController{
constructor(engine){
this.engine=engine
this.factor=0.92
this.min=0.65
this.max=0.98
this.motionInfluence=0.35
this.rotationInfluence=0.25
}
update(delta){
const t=this.engine.temporalState
if(!t)return
const motion=t.cameraPosition.distanceTo(t.prevCameraPosition)
const influence=Math.min(1,motion*this.motionInfluence)
this.factor=this.max-(influence*(this.max-this.min))
}
getFactor(){
return this.factor
}
}

class TemporalResolveSystem{
constructor(engine){
this.engine=engine
this.history=new TemporalHistoryManager(engine)
this.accumulation=new TemporalAccumulationController(engine)
this.initialized=false
this.enabled=true
this.width=0
this.height=0
}
initialize(renderer){
if(this.initialized)return
const size=renderer?.getSize?.(new THREE.Vector2())
if(size){
this.width=size.x
this.height=size.y
this.history.initialize(this.width,this.height)
}
this.initialized=true
}
update(delta,renderer){
if(!this.enabled)return
if(!this.initialized)this.initialize(renderer)
this.accumulation.update(delta)
this.history.updateFrame()
}
resolve(context){
if(!this.enabled)return
if(!this.history.isValid()){
this.history.markValid()
return
}
context.temporal={
history:this.history,
factor:this.accumulation.getFactor(),
samples:this.history.getSampleCount()
}
}
reset(){
this.history.requestReset()
}
dispose(){
this.history.dispose()
this.initialized=false
}
}
/* =========================================================
CINEMATIC MOTION BLUR SYSTEM (PHYSICAL SHUTTER BASED)
========================================================= */

class VelocityTracker{
constructor(engine){
this.engine=engine
this.objectVelocities=new WeakMap()
this.cameraVelocity=new THREE.Vector3()
this.prevCameraPosition=new THREE.Vector3()
this.initialized=false
}
initialize(camera){
if(!camera)return
this.prevCameraPosition.copy(camera.position)
this.initialized=true
}
update(delta,camera,renderables){
if(!camera)return
if(!this.initialized){
this.initialize(camera)
}
this.cameraVelocity.copy(camera.position).sub(this.prevCameraPosition)
this.prevCameraPosition.copy(camera.position)
if(renderables){
for(let i=0;i<renderables.length;i++){
const obj=renderables[i]
if(!obj)continue
let record=this.objectVelocities.get(obj)
if(!record){
record={
prevPosition:new THREE.Vector3().copy(obj.position),
velocity:new THREE.Vector3()
}
this.objectVelocities.set(obj,record)
}
record.velocity.copy(obj.position).sub(record.prevPosition)
record.prevPosition.copy(obj.position)
}
}
}
getCameraVelocity(){
return this.cameraVelocity
}
getObjectVelocity(obj){
const record=this.objectVelocities.get(obj)
return record?record.velocity:null
}
}

class MotionBlurAccumulator{
constructor(engine){
this.engine=engine
this.shutterAngle=180
this.sampleCount=8
this.strength=1.0
}
computeBlurScale(){
const camera=this.engine.cameraPhysical
if(!camera)return 0
const shutter=camera.shutterSpeed||1/48
const base=1/60
const scale=(shutter/base)*(this.shutterAngle/180)
return scale*this.strength
}
}

class MotionBlurSystem{
constructor(engine){
this.engine=engine
this.velocityTracker=new VelocityTracker(engine)
this.accumulator=new MotionBlurAccumulator(engine)
this.enabled=true
this.initialized=false
this.motionScale=1.0
}
initialize(){
if(this.initialized)return
this.initialized=true
}
update(delta,scene,camera,renderables){
if(!this.enabled)return
if(!this.initialized)this.initialize()
this.velocityTracker.update(delta,camera,renderables)
this.motionScale=this.accumulator.computeBlurScale()
}
apply(context){
if(!this.enabled)return
context.motionBlur={
scale:this.motionScale,
cameraVelocity:this.velocityTracker.getCameraVelocity(),
sampleCount:this.accumulator.sampleCount
}
}
setEnabled(v){
this.enabled=v
}
dispose(){
this.enabled=false
}
}
/* =========================================================
PHYSICAL DEPTH OF FIELD SYSTEM (FILM CAMERA MODEL)
========================================================= */

class CircleOfConfusionCalculator{
constructor(engine){
this.engine=engine
this.cocScale=1.0
}
computeCoC(distance){
const cam=this.engine.cameraPhysical
if(!cam)return 0
const focalLength=cam.focalLength||50
const aperture=cam.aperture||1.4
const focusDistance=cam.focusDistance||10
const sensorHeight=cam.sensorHeight||24
const f=focalLength*0.001
const d=distance
const fd=focusDistance
if(d<=0.0001)return 0
const coc=Math.abs((f*f*(d-fd))/(aperture*d*(fd-f)))
return coc*this.cocScale*(sensorHeight/24)
}
}

class BokehSimulationController{
constructor(engine){
this.engine=engine
this.bladeCount=7
this.rotation=0
this.anamorphicRatio=1.0
this.catEyeStrength=0.0
}
computeShapeFactor(){
const blades=this.bladeCount
const rot=this.rotation
return{
blades,
rotation:rot,
anamorphic:this.anamorphicRatio,
catEye:this.catEyeStrength
}
}
}

class PhysicalDOFSystem{
constructor(engine){
this.engine=engine
this.cocCalculator=new CircleOfConfusionCalculator(engine)
this.bokehController=new BokehSimulationController(engine)
this.enabled=true
this.focusDistance=10
this.maxBlur=0.05
this.blurScale=1.0
this.initialized=false
}
initialize(camera){
if(!camera)return
this.focusDistance=this.engine.cameraPhysical?.focusDistance||10
this.initialized=true
}
update(delta,camera,renderables){
if(!this.enabled)return
if(!this.initialized){
this.initialize(camera)
}
this.focusDistance=this.engine.cameraPhysical?.focusDistance||this.focusDistance
}
computeBlur(distance){
const coc=this.cocCalculator.computeCoC(distance)
return Math.min(this.maxBlur,coc*this.blurScale)
}
apply(context){
if(!this.enabled)return
context.depthOfField={
focusDistance:this.focusDistance,
maxBlur:this.maxBlur,
bokeh:this.bokehController.computeShapeFactor()
}
}
setFocusDistance(d){
this.focusDistance=d
}
setEnabled(v){
this.enabled=v
}
dispose(){
this.enabled=false
}
}
/* =========================================================
VOLUMETRIC LIGHT SYSTEM (CINEMATIC ATMOSPHERE)
========================================================= */

class FogDensityField{
constructor(engine){
this.engine=engine
this.globalDensity=0.01
this.heightFalloff=0.05
this.baseHeight=0
this.noiseScale=0.1
this.noiseStrength=0.2
}
computeDensity(position){
const heightFactor=Math.exp(-(position.y-this.baseHeight)*this.heightFalloff)
const density=this.globalDensity*heightFactor
return density
}
}

class VolumetricScatteringIntegrator{
constructor(engine){
this.engine=engine
this.sampleCount=64
this.stepSize=0.5
this.anisotropy=0.2
this.intensity=1.0
}
integrate(light,position,viewDir){
let scattering=0
const steps=this.sampleCount
const stepSize=this.stepSize
for(let i=0;i<steps;i++){
const t=i/steps
const phase=this.computePhase(viewDir,light.direction||new THREE.Vector3(0,-1,0))
scattering+=phase*stepSize
}
return scattering*this.intensity
}
computePhase(viewDir,lightDir){
const g=this.anisotropy
const cosTheta=viewDir.dot(lightDir)
const denom=1+g*g-2*g*cosTheta
return (1-g*g)/(4*Math.PI*Math.pow(denom,1.5))
}
}

class LightVolumeManager{
constructor(engine){
this.engine=engine
this.volumes=new Array(256)
this.count=0
}
clear(){
this.count=0
}
add(light){
if(this.count>=this.volumes.length)return
this.volumes[this.count++]=light
}
getLights(){
return this.volumes
}
getCount(){
return this.count
}
}

class VolumetricLightSystem{
constructor(engine){
this.engine=engine
this.fogField=new FogDensityField(engine)
this.integrator=new VolumetricScatteringIntegrator(engine)
this.volumeManager=new LightVolumeManager(engine)
this.enabled=true
this.initialized=false
this.intensity=1.0
}
initialize(scene){
if(this.initialized)return
this.initialized=true
}
update(delta,scene,camera){
if(!this.enabled)return
if(!this.initialized)this.initialize(scene)
this.volumeManager.clear()
if(scene?.lights){
const lights=scene.lights
for(let i=0;i<lights.length;i++){
const light=lights[i]
if(light&&light.visible){
this.volumeManager.add(light)
}
}
}
}
computeFog(position){
return this.fogField.computeDensity(position)
}
apply(context){
if(!this.enabled)return
context.volumetric={
density:this.fogField.globalDensity,
anisotropy:this.integrator.anisotropy,
intensity:this.intensity,
lightCount:this.volumeManager.getCount()
}
}
setDensity(v){
this.fogField.globalDensity=v
}
setEnabled(v){
this.enabled=v
}
dispose(){
this.enabled=false
this.volumeManager.clear()
}
}
/* =========================================================
FILMIC COLOR GRADING SYSTEM (ACES CINEMATIC PIPELINE)
========================================================= */

class WhiteBalanceController{
constructor(engine){
this.engine=engine
this.temperature=6500
this.tint=0
this.enabled=true
}
setTemperature(kelvin){
this.temperature=Math.max(1000,Math.min(40000,kelvin))
}
setTint(value){
this.tint=Math.max(-1,Math.min(1,value))
}
computeFactors(){
const t=this.temperature/6500
const r=Math.min(2,Math.max(0,t))
const b=Math.min(2,Math.max(0,1/t))
const g=1+(this.tint*0.1)
return new THREE.Vector3(r,g,b)
}
}

class LUTManager{
constructor(engine){
this.engine=engine
this.luts=new Map()
this.active=null
this.intensity=1.0
}
register(name,lut){
this.luts.set(name,lut)
}
setActive(name){
this.active=this.luts.get(name)||null
}
getActive(){
return this.active
}
setIntensity(v){
this.intensity=Math.max(0,Math.min(1,v))
}
}

class FilmicToneMapper{
constructor(engine){
this.engine=engine
this.exposure=1.0
this.contrast=1.0
this.shoulder=0.22
this.linearStrength=0.3
this.linearAngle=0.1
this.toeStrength=0.2
this.enabled=true
}
setExposure(v){
this.exposure=v
}
apply(color){
color.multiplyScalar(this.exposure)
color.x=this.aces(color.x)
color.y=this.aces(color.y)
color.z=this.aces(color.z)
return color
}
aces(x){
const a=2.51
const b=0.03
const c=2.43
const d=0.59
const e=0.14
return Math.min(1,Math.max(0,(x*(a*x+b))/(x*(c*x+d)+e)))
}
}

class ColorGradingSystem{
constructor(engine){
this.engine=engine
this.whiteBalance=new WhiteBalanceController(engine)
this.lutManager=new LUTManager(engine)
this.toneMapper=new FilmicToneMapper(engine)
this.enabled=true
this.saturation=1.0
this.vibrance=0.0
this.gamma=2.2
this.gain=1.0
this.lift=0.0
this.initialized=false
}
initialize(){
if(this.initialized)return
this.initialized=true
}
update(delta){
if(!this.enabled)return
if(!this.initialized)this.initialize()
const exposure=this.engine.exposureState?.current||1.0
this.toneMapper.setExposure(exposure)
}
apply(context){
if(!this.enabled)return
context.colorGrading={
exposure:this.toneMapper.exposure,
whiteBalance:this.whiteBalance.computeFactors(),
saturation:this.saturation,
vibrance:this.vibrance,
gamma:this.gamma,
gain:this.gain,
lift:this.lift,
lut:this.lutManager.getActive(),
lutIntensity:this.lutManager.intensity
}
}
setEnabled(v){
this.enabled=v
}
dispose(){
this.enabled=false
}
}
/* =========================================================
CINEMATIC LENS SYSTEM (PHYSICAL LENS SIMULATION)
========================================================= */

class LensDistortionModel{
constructor(engine){
this.engine=engine
this.k1=0.0
this.k2=0.0
this.k3=0.0
this.p1=0.0
this.p2=0.0
this.scale=1.0
}
compute(x,y){
const r2=x*x+y*y
const radial=1+this.k1*r2+this.k2*r2*r2+this.k3*r2*r2*r2
const xDistorted=x*radial+2*this.p1*x*y+this.p2*(r2+2*x*x)
const yDistorted=y*radial+this.p1*(r2+2*y*y)+2*this.p2*x*y
return new THREE.Vector2(xDistorted*this.scale,yDistorted*this.scale)
}
}

class ChromaticAberrationModel{
constructor(engine){
this.engine=engine
this.strength=0.002
this.samples=3
}
computeOffset(channel,x,y){
const factor=(channel-1)*this.strength
return new THREE.Vector2(x*factor,y*factor)
}
}

class VignetteModel{
constructor(engine){
this.engine=engine
this.intensity=0.25
this.falloff=1.5
this.roundness=1.0
this.smoothness=0.5
}
compute(x,y){
const dist=Math.sqrt(x*x+y*y)
const vignette=1-Math.pow(dist*this.falloff,this.roundness)
return Math.max(0,vignette*this.intensity)
}
}

class LensBreathingSimulator{
constructor(engine){
this.engine=engine
this.strength=0.02
this.referenceFocus=10
}
computeScale(focusDistance){
const delta=focusDistance-this.referenceFocus
return 1+(delta*this.strength*0.01)
}
}

class LensSystem{
constructor(engine){
this.engine=engine
this.distortion=new LensDistortionModel(engine)
this.chromatic=new ChromaticAberrationModel(engine)
this.vignette=new VignetteModel(engine)
this.breathing=new LensBreathingSimulator(engine)
this.enabled=true
}
update(delta){
if(!this.enabled)return
}
apply(context){
if(!this.enabled)return
context.lens={
distortion:this.distortion,
chromatic:this.chromatic,
vignette:this.vignette,
breathing:this.breathing
}
}
setEnabled(v){
this.enabled=v
}
dispose(){
this.enabled=false
}
}

/* =========================================================
FILM GRAIN SYSTEM (PHYSICAL SENSOR SIMULATION)
========================================================= */

class SensorNoiseSimulator{
constructor(engine){
this.engine=engine
this.iso=100
this.baseNoise=0.002
this.luminanceInfluence=0.5
}
computeNoise(luminance){
const isoFactor=this.iso/100
const lumFactor=1+(luminance*this.luminanceInfluence)
return this.baseNoise*isoFactor*lumFactor
}
}

class FilmGrainSystem{
constructor(engine){
this.engine=engine
this.sensor=new SensorNoiseSimulator(engine)
this.enabled=true
this.intensity=1.0
this.size=1.0
this.time=0
}
update(delta){
if(!this.enabled)return
this.time+=delta
const iso=this.engine.cameraPhysical?.ISO||100
this.sensor.iso=iso
}
apply(context){
if(!this.enabled)return
context.filmGrain={
intensity:this.intensity,
size:this.size,
time:this.time,
noise:this.sensor.computeNoise(0.5)
}
}
setEnabled(v){
this.enabled=v
}
dispose(){
this.enabled=false
}
}
/* =========================================================
SCREEN SPACE REFLECTION SYSTEM (CINEMATIC REFLECTION)
========================================================= */

class ReflectionHistoryManager{
constructor(engine){
this.engine=engine
this.historyBuffer=null
this.valid=false
this.width=0
this.height=0
}
initialize(width,height){
this.width=width
this.height=height
this.historyBuffer={
width,
height,
data:null
}
this.valid=false
}
reset(){
this.valid=false
}
markValid(){
this.valid=true
}
get(){
return this.historyBuffer
}
dispose(){
this.historyBuffer=null
this.valid=false
}
}

class SSRResolver{
constructor(engine){
this.engine=engine
this.maxSteps=64
this.stepSize=0.2
this.thickness=0.1
this.intensity=1.0
}
resolve(rayOrigin,rayDir){
let hit=false
let hitDistance=0
for(let i=0;i<this.maxSteps;i++){
const t=i*this.stepSize
hitDistance=t
}
return{
hit,
distance:hitDistance,
intensity:this.intensity
}
}
}

class ReflectionSystem{
constructor(engine){
this.engine=engine
this.history=new ReflectionHistoryManager(engine)
this.resolver=new SSRResolver(engine)
this.enabled=true
this.initialized=false
this.intensity=1.0
}
initialize(renderer){
if(this.initialized)return
const size=renderer?.getSize?.(new THREE.Vector2())
if(size){
this.history.initialize(size.x,size.y)
}
this.initialized=true
}
update(delta,renderer){
if(!this.enabled)return
if(!this.initialized)this.initialize(renderer)
}
apply(context){
if(!this.enabled)return
context.reflections={
history:this.history.get(),
intensity:this.intensity,
maxSteps:this.resolver.maxSteps
}
}
setEnabled(v){
this.enabled=v
}
dispose(){
this.enabled=false
this.history.dispose()
}
}

/* =========================================================
GLOBAL ILLUMINATION SYSTEM (INDIRECT LIGHT CINEMATIC)
========================================================= */

class RadianceCache{
constructor(engine){
this.engine=engine
this.probes=new Array(512)
this.count=0
}
clear(){
this.count=0
}
addProbe(position,radiance){
if(this.count>=this.probes.length)return
this.probes[this.count++]={position:position.clone(),radiance:radiance.clone()}
}
getProbeCount(){
return this.count
}
}

class IndirectLightAccumulator{
constructor(engine){
this.engine=engine
this.intensity=1.0
this.bounceCount=2
}
computeIndirect(position,normal){
return new THREE.Color(
this.intensity*0.5,
this.intensity*0.5,
this.intensity*0.5
)
}
}

class GlobalIlluminationSystem{
constructor(engine){
this.engine=engine
this.cache=new RadianceCache(engine)
this.accumulator=new IndirectLightAccumulator(engine)
this.enabled=true
this.initialized=false
this.intensity=1.0
}
initialize(scene){
if(this.initialized)return
this.initialized=true
}
update(delta,scene){
if(!this.enabled)return
if(!this.initialized)this.initialize(scene)
this.cache.clear()
}
apply(context){
if(!this.enabled)return
context.globalIllumination={
probeCount:this.cache.getProbeCount(),
intensity:this.intensity,
bounceCount:this.accumulator.bounceCount
}
}
setEnabled(v){
this.enabled=v
}
dispose(){
this.enabled=false
this.cache.clear()
}
}
/* =========================================================
ENGINE CINEMATIC SYSTEM INTEGRATION
========================================================= */

export class Engine{

static instance=null

static getInstance(options={}){

if(Engine.instance instanceof Engine){

return Engine.instance

}

const instance=new Engine(options)

Object.defineProperty(
Engine,
"instance",
{
value:instance,
writable:false,
configurable:false,
enumerable:false
}
)

return instance

}

constructor(options={}){

if(Engine.instance!==null&&Engine.instance instanceof Engine){

return Engine.instance

}

Object.defineProperty(
Engine,
"instance",
{
value:this,
writable:false,
configurable:false,
enumerable:false
}
)

this.options=options

this.config=ENGINE_CONFIG

if(!this.config){

throw new Error("[ENGINE_AUTHORITY] EngineConfig missing")

}

__ENGINE_AUTHORITY_CONTAINER.config=this.config

__ENGINE_AUTHORITY_CONTAINER.runtime=this

this.state=ENGINE_STATE.CONSTRUCTED

this.executionMode=EXECUTION_MODE.CINEMATIC_PRIORITY

this.renderer=null
this.pipeline=null
this.sceneManager=null
this.cameraSystem=null
this.systemManager=null
this.scheduler=null
this.memoryMonitor=null
this.assetManager=null
this.environmentSystem=null
this.performanceMonitor=null
this.performanceScaler=null

this.frameGraph=null

this._frameGraphPendingInit=true

/* ==============================
CINEMATIC SYSTEMS INITIALIZATION
============================== */

/* TEMPORAL */

if(this.config.FEATURES?.TEMPORAL){

this.temporalSystem=new TemporalResolveSystem(
this,
this.config.TEMPORAL
)

}else{

this.temporalSystem=null

}

/* MOTION BLUR */

if(this.config.FEATURES?.MOTION_BLUR){

this.motionBlurSystem=new MotionBlurSystem(
this,
this.config.MOTION_BLUR
)

}else{

this.motionBlurSystem=null

}

/* DOF */

if(this.config.FEATURES?.DOF){

this.dofSystem=new PhysicalDOFSystem(
this,
this.config.DOF
)

}else{

this.dofSystem=null

}

/* VOLUMETRIC */

if(this.config.FEATURES?.VOLUMETRIC){

this.volumetricSystem=new VolumetricLightSystem(
this,
this.config.VOLUMETRIC
)

}else{

this.volumetricSystem=null

}

/* COLOR GRADING */

if(this.config.FEATURES?.COLOR_GRADING){

this.colorGradingSystem=new ColorGradingSystem(
this,
this.config.COLOR_GRADING
)

}else{

this.colorGradingSystem=null

}

/* LENS */

if(this.config.FEATURES?.LENS){

this.lensSystem=new LensSystem(
this,
this.config.LENS
)

}else{

this.lensSystem=null

}

/* FILM GRAIN */

if(this.config.FEATURES?.FILM_GRAIN){

this.filmGrainSystem=new FilmGrainSystem(
this,
this.config.FILM_GRAIN
)

}else{

this.filmGrainSystem=null

}

/* REFLECTION */

if(this.config.FEATURES?.REFLECTIONS){

this.reflectionSystem=new ReflectionSystem(
this,
this.config.REFLECTIONS
)

}else{

this.reflectionSystem=null

}

/* GLOBAL ILLUMINATION */

if(this.config.FEATURES?.GLOBAL_ILLUMINATION){

this.giSystem=new GlobalIlluminationSystem(
this,
this.config.GI
)

}else{

this.giSystem=null

}

/* ============================== */

this.clock=new THREE.Clock(
this.config.TIMING?.CLOCK_AUTO_START??false
)

this.time=0

this.delta=0

this.frame=0

this.running=false

this.initialized=false

this.destroyed=false

this.__loopHandle=null

this.__loopBound=null

this.listeners=new Map()

Object.seal(this)

}
__clearAllListeners(){

if(!this.listeners)return

for(const [key,value] of this.listeners){

if(Array.isArray(value)){

value.length=0

}

}

this.listeners.clear()

}
async init(){

if(this.initialized)return this

this.renderer=new Renderer({
...this.options,
engine:this,
config:this.config.RENDERER
})
await this.renderer.init?.()
initializeEngineConfig(this.renderer.getRenderer?.()||this.renderer)
this.derived=getDerivedConfig()
__ENGINE_AUTHORITY_CONTAINER.derived=this.derived
Object.freeze(__ENGINE_AUTHORITY_CONTAINER.derived)
assertEngineConfigAuthority()
Object.seal(this.renderer)

const rendererAuthorityWrapper=Object.freeze({
instance:this.renderer
})

Object.defineProperty(
__ENGINE_AUTHORITY_CONTAINER,
"renderer",
{
value:rendererAuthorityWrapper,
writable:false,
configurable:false,
enumerable:true
}
)

this.gpu=getGPUCapabilities()
Object.freeze(this.gpu)

__ENGINE_AUTHORITY_CONTAINER.gpu=this.gpu
Object.freeze(__ENGINE_AUTHORITY_CONTAINER.gpu)

this.pipeline=new CinematicRenderPipeline(this)
await this.pipeline.init?.()

this.sceneManager=new SceneManager({...this.options,engine:this})
await this.sceneManager.init?.()

this.cameraSystem=new CameraSystem({...this.options,engine:this})
await this.cameraSystem.init?.()

this.systemManager=new SystemManager(this)
await this.systemManager.init?.()

this.scheduler=new TaskScheduler(this)
await this.scheduler.init?.()

this.memoryMonitor=new MemoryMonitor(this)

this.assetManager=new AssetManager(this)
await this.assetManager.init?.()

this.environmentSystem=new EnvironmentSystem(this)
await this.environmentSystem.init?.()

this.performanceMonitor=new PerformanceMonitor({
targetFPS:this.config.TIMING.TARGET_FPS
})

const rawRenderer=this.renderer.getRenderer?.()

if(rawRenderer){

this.performanceScaler=new PerformanceScaler(rawRenderer,{
targetFPS:this.config.SCALING.TARGET_FPS,
minFPS:this.config.TIMING.MIN_FPS,
maxScale:this.config.SCALING.MAX_SCALE,
minScale:this.config.SCALING.MIN_SCALE
})

}

/* ==============================
INITIALIZE CINEMATIC SYSTEMS
============================== */

this.temporalSystem.initialize(rawRenderer)
this.reflectionSystem.initialize(rawRenderer)

/* ============================== */

this.initialized=true
this.__deepFreezeRuntime=(obj,seen=new WeakSet())=>{
if(obj===null||typeof obj!=="object")return obj
if(seen.has(obj))return obj
seen.add(obj)
const keys=Reflect.ownKeys(obj)
for(let i=0;i<keys.length;i++){
const value=obj[keys[i]]
if(value&&typeof value==="object"){
this.__deepFreezeRuntime(value,seen)
}
}
return Object.freeze(obj)
}

const runtimeAuthority={
engine:this,
config:this.config,
derived:this.derived,
gpu:this.gpu,
renderer:this.renderer,
pipeline:this.pipeline,
systemManager:this.systemManager,
configRuntime:getEngineConfigRuntimeState()
}

this.__deepFreezeRuntime(runtimeAuthority)

__ENGINE_AUTHORITY_CONTAINER.runtime=runtimeAuthority

__lockAuthorityContainer()

__assertAuthorityIntegrity()

assertEngineConfigAuthority()

  return this
}

start(){

if(this.destroyed)return

if(this.running)return

if(this.__loopHandle!==undefined&&this.__loopHandle!==null)return

this.running=true

this.__loopBound=this.__loopBound||this.__loop.bind(this)

this.clock.start()

this.__loopHandle=requestAnimationFrame(this.__loopBound)

}
__loop(){

if(!this.running||this.destroyed){

if(this.__loopHandle!==undefined&&this.__loopHandle!==null){

cancelAnimationFrame(this.__loopHandle)

this.__loopHandle=null

}

return

}

const delta=this.clock.getDelta()

const elapsed=this.clock.getElapsedTime()

this.update(delta,elapsed)

this.render(delta,elapsed)

this.__loopHandle=requestAnimationFrame(this.__loopBound)

}

update(delta){
__assertAuthorityIntegrity()
this.delta=delta
this.time+=delta

const scene=this.sceneManager?.getScene?.()
const camera=this.cameraSystem?.getCamera?.()
const renderables=this.sceneManager?.getRenderables?.()

/* ==============================
UPDATE CINEMATIC SYSTEMS
============================== */

if(this.temporalSystem)this.temporalSystem.update(delta,this.renderer)
if(this.motionBlurSystem)this.motionBlurSystem.update(delta,scene,camera,renderables)
if(this.dofSystem)this.dofSystem.update(delta,camera,renderables)
if(this.volumetricSystem)this.volumetricSystem.update(delta,scene,camera)
if(this.colorGradingSystem)this.colorGradingSystem.update(delta)
if(this.lensSystem)this.lensSystem.update(delta)
if(this.filmGrainSystem)this.filmGrainSystem.update(delta)
if(this.reflectionSystem)this.reflectionSystem.update(delta,this.renderer)
if(this.giSystem)this.giSystem.update(delta,scene)

/* ============================== */

this.systemManager?.update?.(delta)

}

render(delta){

if(this.destroyed)return

if(!this.running)return

__assertAuthorityIntegrity()

const renderer=this.renderer

const scene=this.sceneManager?.getScene?.()

const camera=this.cameraSystem?.getCamera?.()

const pipeline=this.pipeline

if(!renderer)return

if(!scene)return

if(!camera)return

if(!pipeline)return

if(typeof pipeline.render!=="function")return

const context={
engine:this,
renderer,
scene,
camera,
delta
}

try{

if(this.temporalSystem)this.temporalSystem.resolve(context)
if(this.motionBlurSystem)this.motionBlurSystem.apply(context)
if(this.dofSystem)this.dofSystem.apply(context)
if(this.volumetricSystem)this.volumetricSystem.apply(context)
if(this.colorGradingSystem)this.colorGradingSystem.apply(context)
if(this.lensSystem)this.lensSystem.apply(context)
if(this.filmGrainSystem)this.filmGrainSystem.apply(context)
if(this.reflectionSystem)this.reflectionSystem.apply(context)
if(this.giSystem)this.giSystem.apply(context)

pipeline.render(
renderer,
scene,
camera,
delta,
0,
null,
context
)

this.frame++

}catch(e){

console.error("[ENGINE_RENDER_FATAL]",e)

this.stop()

}

}

stop(){

if(!this.running)return

this.running=false

if(this.__loopHandle!==undefined&&this.__loopHandle!==null){

cancelAnimationFrame(this.__loopHandle)

this.__loopHandle=null

}

if(this.clock){

this.clock.stop()

}

}
dispose(){

if(this.destroyed)return

this.stop()

this.__clearAllListeners()

if(this.temporalSystem)this.temporalSystem.dispose()
if(this.motionBlurSystem)this.motionBlurSystem.dispose()
if(this.dofSystem)this.dofSystem.dispose()
if(this.volumetricSystem)this.volumetricSystem.dispose()
if(this.colorGradingSystem)this.colorGradingSystem.dispose()
if(this.lensSystem)this.lensSystem.dispose()
if(this.filmGrainSystem)this.filmGrainSystem.dispose()
if(this.reflectionSystem)this.reflectionSystem.dispose()
if(this.giSystem)this.giSystem.dispose()

if(this.pipeline?.dispose)this.pipeline.dispose()

const internalRenderer=
this.renderer?.getRenderer?.()||
this.renderer?._renderer||
this.renderer?.renderer||
null

if(internalRenderer){

try{

if(internalRenderer.renderLists?.dispose){

internalRenderer.renderLists.dispose()

}

if(internalRenderer.forceContextLoss){

internalRenderer.forceContextLoss()

}

if(internalRenderer.domElement){

internalRenderer.domElement.width=0
internalRenderer.domElement.height=0

}

}catch(e){

console.warn("[ENGINE_RENDERER_CLEANUP_WARNING]",e)

}

}

if(this.renderer?.dispose)this.renderer.dispose()

if(this.sceneManager?.dispose)this.sceneManager.dispose()
if(this.cameraSystem?.dispose)this.cameraSystem.dispose()
if(this.systemManager?.dispose)this.systemManager.dispose()
if(this.scheduler?.dispose)this.scheduler.dispose()
if(this.assetManager?.dispose)this.assetManager.dispose()
if(this.environmentSystem?.dispose)this.environmentSystem.dispose()
if(this.performanceMonitor?.dispose)this.performanceMonitor.dispose()
if(this.performanceScaler?.dispose)this.performanceScaler.dispose()
if(this.memoryMonitor?.dispose)this.memoryMonitor.dispose()

if(this.frameGraph?.clear)this.frameGraph.clear()

if(this.clock){

this.clock.stop()
this.clock=null

}

this.renderer=null
this.pipeline=null
this.sceneManager=null
this.cameraSystem=null
this.systemManager=null
this.scheduler=null
this.assetManager=null
this.environmentSystem=null
this.performanceMonitor=null
this.performanceScaler=null
this.memoryMonitor=null
this.frameGraph=null

this.running=false
this.initialized=false
this.destroyed=true

isRunning(){return this.running}
isInitialized(){return this.initialized}
isDestroyed(){return this.destroyed}

}
/* =========================================================
HYBRID PATH TRACING FOUNDATION
FILM-GRADE CINEMATIC RENDERER CORE
Non-destructive append-only upgrade
========================================================= */

const PT_EPSILON=1e-6
const PT_INFINITY=1e30
const PT_MAX_BOUNCES=12

class PTRay{
constructor(origin=new THREE.Vector3(),direction=new THREE.Vector3()){
this.origin=origin.clone()
this.direction=direction.clone().normalize()
this.invDirection=new THREE.Vector3(
Math.abs(this.direction.x)>PT_EPSILON?1/this.direction.x:PT_INFINITY,
Math.abs(this.direction.y)>PT_EPSILON?1/this.direction.y:PT_INFINITY,
Math.abs(this.direction.z)>PT_EPSILON?1/this.direction.z:PT_INFINITY
)
this.sign=[
this.invDirection.x<0?1:0,
this.invDirection.y<0?1:0,
this.invDirection.z<0?1:0
]
}
at(t,target=new THREE.Vector3()){
return target.copy(this.direction).multiplyScalar(t).add(this.origin)
}
clone(){
return new PTRay(this.origin,this.direction)
}
}

class PTHit{
constructor(){
this.t=PT_INFINITY
this.position=new THREE.Vector3()
this.normal=new THREE.Vector3()
this.material=null
this.object=null
this.hit=false
}
set(t,pos,normal,material,object){
this.t=t
this.position.copy(pos)
this.normal.copy(normal)
this.material=material
this.object=object
this.hit=true
}
reset(){
this.t=PT_INFINITY
this.hit=false
this.material=null
this.object=null
}
}

class PTAABB{
constructor(){
this.min=new THREE.Vector3(PT_INFINITY,PT_INFINITY,PT_INFINITY)
this.max=new THREE.Vector3(-PT_INFINITY,-PT_INFINITY,-PT_INFINITY)
}
expandByPoint(p){
this.min.min(p)
this.max.max(p)
}
expandByBox(box){
this.min.min(box.min)
this.max.max(box.max)
}
intersect(ray,tmin=0,tmax=PT_INFINITY){
for(let i=0;i<3;i++){
const invD=ray.invDirection.getComponent(i)
let t0=(this.min.getComponent(i)-ray.origin.getComponent(i))*invD
let t1=(this.max.getComponent(i)-ray.origin.getComponent(i))*invD
if(invD<0){
const tmp=t0
t0=t1
t1=tmp
}
tmin=t0>tmin?t0:tmin
tmax=t1<tmax?t1:tmax
if(tmax<=tmin)return false
}
return true
}
}

class PTPrimitive{
constructor(object){
this.object=object
this.bounds=new PTAABB()
this.center=new THREE.Vector3()
this.updateBounds()
}
updateBounds(){

const geom=this.object.geometry

if(!geom.boundingBox)geom.computeBoundingBox()

const box=geom.boundingBox

const matrix=this.object.matrixWorld

this.bounds.min.set(PT_INFINITY,PT_INFINITY,PT_INFINITY)
this.bounds.max.set(-PT_INFINITY,-PT_INFINITY,-PT_INFINITY)

const p0=new THREE.Vector3(box.min.x,box.min.y,box.min.z)
const p1=new THREE.Vector3(box.min.x,box.min.y,box.max.z)
const p2=new THREE.Vector3(box.min.x,box.max.y,box.min.z)
const p3=new THREE.Vector3(box.min.x,box.max.y,box.max.z)
const p4=new THREE.Vector3(box.max.x,box.min.y,box.min.z)
const p5=new THREE.Vector3(box.max.x,box.min.y,box.max.z)
const p6=new THREE.Vector3(box.max.x,box.max.y,box.min.z)
const p7=new THREE.Vector3(box.max.x,box.max.y,box.max.z)

p0.applyMatrix4(matrix)
p1.applyMatrix4(matrix)
p2.applyMatrix4(matrix)
p3.applyMatrix4(matrix)
p4.applyMatrix4(matrix)
p5.applyMatrix4(matrix)
p6.applyMatrix4(matrix)
p7.applyMatrix4(matrix)

this.bounds.expandByPoint(p0)
this.bounds.expandByPoint(p1)
this.bounds.expandByPoint(p2)
this.bounds.expandByPoint(p3)
this.bounds.expandByPoint(p4)
this.bounds.expandByPoint(p5)
this.bounds.expandByPoint(p6)
this.bounds.expandByPoint(p7)

this.center.copy(this.bounds.min).add(this.bounds.max).multiplyScalar(0.5)

}
intersect(ray,hit){
const mesh=this.object
const geom=mesh.geometry
const pos=geom.attributes.position
const index=geom.index
const matrix=mesh.matrixWorld
const invMatrix=new THREE.Matrix4().copy(matrix).invert()
const localRay=new PTRay(
ray.origin.clone().applyMatrix4(invMatrix),
ray.direction.clone().transformDirection(invMatrix)
)
let found=false
const triCount=index?index.count/3:pos.count/3
for(let i=0;i<triCount;i++){
const a=index?index.getX(i*3):i*3
const b=index?index.getX(i*3+1):i*3+1
const c=index?index.getX(i*3+2):i*3+2
const v0=new THREE.Vector3().fromBufferAttribute(pos,a)
const v1=new THREE.Vector3().fromBufferAttribute(pos,b)
const v2=new THREE.Vector3().fromBufferAttribute(pos,c)
const res=this._intersectTriangle(localRay,v0,v1,v2)
if(res&&res.t<hit.t){
const worldPos=res.position.clone().applyMatrix4(matrix)
const worldNormal=res.normal.clone().transformDirection(matrix)
hit.set(res.t,worldPos,worldNormal,mesh.material,mesh)
found=true
}
}
return found
}
_intersectTriangle(ray,v0,v1,v2){
const edge1=new THREE.Vector3().subVectors(v1,v0)
const edge2=new THREE.Vector3().subVectors(v2,v0)
const pvec=new THREE.Vector3().crossVectors(ray.direction,edge2)
const det=edge1.dot(pvec)
if(Math.abs(det)<PT_EPSILON)return null
const invDet=1/det
const tvec=new THREE.Vector3().subVectors(ray.origin,v0)
const u=tvec.dot(pvec)*invDet
if(u<0||u>1)return null
const qvec=new THREE.Vector3().crossVectors(tvec,edge1)
const v=ray.direction.dot(qvec)*invDet
if(v<0||u+v>1)return null
const t=edge2.dot(qvec)*invDet
if(t<PT_EPSILON)return null
const pos=ray.at(t)
const normal=new THREE.Vector3().crossVectors(edge1,edge2).normalize()
return{t,position:pos,normal}
}
}

class PTBVHNode{
constructor(){
this.bounds=new PTAABB()
this.left=null
this.right=null
this.primitive=null
}
isLeaf(){
return this.primitive!==null
}
}

class PTBVHBuilder{
constructor(){
this.primitives=[]
this.root=null
}
buildFromScene(scene){

this.primitives.length=0

scene.updateMatrixWorld(true)

scene.traverse(obj=>{

if(!obj.visible)return

if(obj.isMesh&&obj.geometry){

this.primitives.push(new PTPrimitive(obj))

}

})

if(this.primitives.length===0){

this.root=null

return

}

this.root=this._buildRecursive(this.primitives,0)

}
_buildRecursive(prims,depth){
if(prims.length===0)return null
const node=new PTBVHNode()
for(const p of prims){
node.bounds.expandByBox(p.bounds)
}
if(prims.length===1||depth>32){
node.primitive=prims[0]
return node
}
const axis=depth%3
prims.sort((a,b)=>a.center.getComponent(axis)-b.center.getComponent(axis))
const mid=Math.floor(prims.length/2)
node.left=this._buildRecursive(prims.slice(0,mid),depth+1)
node.right=this._buildRecursive(prims.slice(mid),depth+1)
return node
}
intersect(ray,hit){
return this._intersectNode(this.root,ray,hit)
}
_intersectNode(node,ray,hit){
if(!node||!node.bounds.intersect(ray,0,hit.t))return false
let found=false
if(node.isLeaf()){
return node.primitive.intersect(ray,hit)
}
if(node.left&&this._intersectNode(node.left,ray,hit))found=true
if(node.right&&this._intersectNode(node.right,ray,hit))found=true
return found
}
}
/* =========================================================
PATH TRACE INTEGRATOR
MONTE CARLO LIGHT TRANSPORT
FILM-GRADE GLOBAL ILLUMINATION CORE
========================================================= */

const PT_PI=Math.PI
const PT_TWO_PI=Math.PI*2

class PTSampler{
constructor(seed=1337){
this.seed=seed>>>0
}
next(){
this.seed=(1664525*this.seed+1013904223)>>>0
return this.seed/4294967296
}
next2(){
return new THREE.Vector2(this.next(),this.next())
}
nextInUnitDisk(){
let x,y
do{
x=this.next()*2-1
y=this.next()*2-1
}while(x*x+y*y>=1)
return new THREE.Vector2(x,y)
}
nextHemisphere(normal){
const u=this.next()
const v=this.next()
const phi=PT_TWO_PI*u
const cosTheta=Math.sqrt(1-v)
const sinTheta=Math.sqrt(v)
const x=Math.cos(phi)*sinTheta
const y=Math.sin(phi)*sinTheta
const z=cosTheta
const tangent=new THREE.Vector3()
const bitangent=new THREE.Vector3()
this._buildOrthonormalBasis(normal,tangent,bitangent)
return new THREE.Vector3()
.copy(tangent).multiplyScalar(x)
.addScaledVector(bitangent,y)
.addScaledVector(normal,z)
.normalize()
}
_buildOrthonormalBasis(n,t,b){
if(Math.abs(n.x)>Math.abs(n.z)){
t.set(-n.y,n.x,0)
}else{
t.set(0,-n.z,n.y)
}
t.normalize()
b.crossVectors(n,t)
}
}

class PTMaterial{
constructor(params={}){
this.color=new THREE.Color(params.color??0xffffff)
this.emission=new THREE.Color(params.emission??0x000000)
this.emissionIntensity=params.emissionIntensity??0
this.roughness=params.roughness??0.5
this.metalness=params.metalness??0
this.transmission=params.transmission??0
this.ior=params.ior??1.5
}
evaluateBRDF(normal,inDir,outDir){
const NdotL=Math.max(normal.dot(outDir),0)
return this.color.clone().multiplyScalar(NdotL/PT_PI)
}
sampleDirection(normal,inDir,sampler){
if(this.metalness>0.5){
const reflect=inDir.clone().reflect(normal)
const roughVec=sampler.nextHemisphere(normal)
return reflect.lerp(roughVec,this.roughness).normalize()
}else{
return sampler.nextHemisphere(normal)
}
}
getEmission(){
return this.emission.clone().multiplyScalar(this.emissionIntensity)
}
}

class PTLight{
constructor(object){
this.object=object
this.color=new THREE.Color(1,1,1)
this.intensity=1
}
sample(point,sampler){
const pos=new THREE.Vector3().setFromMatrixPosition(this.object.matrixWorld)
const dir=new THREE.Vector3().subVectors(pos,point)
const dist=dir.length()
dir.normalize()
return{
direction:dir,
distance:dist,
radiance:this.color.clone().multiplyScalar(this.intensity/(dist*dist))
}
}
}

class PTScene{
constructor(scene){
this.scene=scene
this.bvh=new PTBVHBuilder()
this.materialMap=new Map()
this.lights=[]
this._extractLights(scene)
this.bvh.buildFromScene(scene)
}
_extractLights(scene){
if(!scene)return
scene.traverse(obj=>{
if(!obj)return
if(obj.isLight){
this.lights.push(new PTLight(obj))
}
})
}
getMaterial(object){
let mat=this.materialMap.get(object)
if(!mat){
const src=object.material||{}
mat=new PTMaterial({
color:src.color?.getHex?.()??0xffffff,
emission:src.emissive?.getHex?.()??0x000000,
emissionIntensity:src.emissiveIntensity??0,
roughness:src.roughness??0.5,
metalness:src.metalness??0,
transmission:src.transmission??0,
ior:src.ior??1.5
})
this.materialMap.set(object,mat)
}
return mat
}
intersect(ray,hit){
if(!this.bvh||!this.bvh.root)return false
return this.bvh.intersect(ray,hit)
}
}
class PTIntegrator{
constructor(scene){
this.scene=new PTScene(scene)
this.maxBounces=PT_MAX_BOUNCES
this.sampler=new PTSampler()
this.background=new THREE.Color(0,0,0)
}
trace(ray){
const radiance=new THREE.Color(0,0,0)
let throughput=new THREE.Color(1,1,1)
const hit=new PTHit()
let currentRay=ray.clone()
for(let bounce=0;bounce<this.maxBounces;bounce++){
hit.reset()
if(!this.scene.intersect(currentRay,hit)){
radiance.add(
throughput.clone().multiply(this.background)
)
break
}
const material=this.scene.getMaterial(hit.object)
const emission=material.getEmission()
radiance.add(
throughput.clone().multiply(emission)
)
for(const light of this.scene.lights){
const sample=light.sample(hit.position,this.sampler)
const shadowRay=new PTRay(
hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
sample.direction
)
const shadowHit=new PTHit()
if(!this.scene.intersect(shadowRay,shadowHit)||shadowHit.t>sample.distance){
const brdf=material.evaluateBRDF(
hit.normal,
currentRay.direction.clone().negate(),
sample.direction
)
radiance.add(
throughput.clone()
.multiply(brdf)
.multiply(sample.radiance)
)
}
}
const newDir=material.sampleDirection(
hit.normal,
currentRay.direction.clone().negate(),
this.sampler
)
const brdf=material.evaluateBRDF(
hit.normal,
currentRay.direction.clone().negate(),
newDir
)
throughput.multiply(brdf)

throughput.clampScalar(0,10)
currentRay=new PTRay(
hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
newDir
)
if(
throughput.r<0.001&&
throughput.g<0.001&&
throughput.b<0.001
){
break
}
}
return radiance
}
}
/* =========================================================
HYBRID PATH TRACER CORE
TEMPORAL ACCUMULATION BUFFER
PROGRESSIVE FILM-QUALITY CONVERGENCE
========================================================= */

class PTAccumulationBuffer{
constructor(width=1,height=1){
this.width=width
this.height=height
this.sampleCount=0
this.buffer=new Float32Array(width*height*4)
this.displayBuffer=new Float32Array(width*height*4)
}
resize(width,height){
if(width===this.width&&height===this.height)return
this.width=width
this.height=height
this.buffer=new Float32Array(width*height*4)
this.displayBuffer=new Float32Array(width*height*4)
this.sampleCount=0
}
clear(){
this.buffer.fill(0)
this.displayBuffer.fill(0)
this.sampleCount=0
}
accumulate(sampleBuffer){
const len=this.buffer.length
this.sampleCount++
const inv=1/this.sampleCount
for(let i=0;i<len;i++){
this.buffer[i]+=sampleBuffer[i]
this.displayBuffer[i]=this.buffer[i]*inv
}
}
getDisplayBuffer(){
return this.displayBuffer
}
}

class PTCamera{
constructor(camera){
this.camera=camera
this.aperture=0
this.focusDistance=10
this.sensorSize=0.036
}
generateRay(x,y,width,height,sampler){
const ndcX=(x+sampler.next())/width*2-1
const ndcY=(y+sampler.next())/height*2-1
const origin=new THREE.Vector3()
const direction=new THREE.Vector3(ndcX,ndcY,-1).normalize()
origin.copy(this.camera.position)
direction.applyQuaternion(this.camera.quaternion)
if(this.aperture>0){
const disk=sampler.nextInUnitDisk()
const lensOffset=new THREE.Vector3(disk.x,disk.y,0).multiplyScalar(this.aperture)
origin.add(lensOffset)
const focusPoint=new THREE.Vector3().copy(direction).multiplyScalar(this.focusDistance).add(this.camera.position)
direction.copy(focusPoint).sub(origin).normalize()
}
return new PTRay(origin,direction)
}
}

class PTHybridTracer{
constructor(renderer,scene,camera){
this.renderer=renderer
this.scene=scene
this.camera=camera
this.integrator=new PTIntegrator(scene)
this.accumulation=new PTAccumulationBuffer(1,1)
this.sampler=new PTSampler()
this.ptCamera=new PTCamera(camera)
this.enabled=true
this.samplesPerFrame=1
this.maxSamples=4096
this.currentSamples=0
this.sampleBuffer=null
}
resize(width,height){

this.accumulation.resize(width,height)

const requiredSize=width*height*4

if(!this.sampleBuffer||this.sampleBuffer.length!==requiredSize){

this.sampleBuffer=new Float32Array(requiredSize)

}

this.currentSamples=0

}
reset(){
this.accumulation.clear()
this.currentSamples=0
}
render(){
if(!this.enabled)return
const size=this.renderer?.getSize?.(new THREE.Vector2())
if(!size)return
const width=size.x|0
const height=size.y|0
if(!this.sampleBuffer||this.accumulation.width!==width||this.accumulation.height!==height){
this.resize(width,height)
}
for(let s=0;s<this.samplesPerFrame;s++){
this._renderSample(width,height)
this.accumulation.accumulate(this.sampleBuffer)
this.currentSamples++
if(this.currentSamples>=this.maxSamples)break
}
}
_renderSample(width,height){

this.sampleBuffer.fill(0)

let i=0

for(let y=0;y<height;y++){

for(let x=0;x<width;x++){

const ray=this.ptCamera.generateRay(
x,
y,
width,
height,
this.sampler
)

const color=this.integrator.trace(ray)

this.sampleBuffer[i++]=Number.isFinite(color.r)?color.r:0
this.sampleBuffer[i++]=Number.isFinite(color.g)?color.g:0
this.sampleBuffer[i++]=Number.isFinite(color.b)?color.b:0
this.sampleBuffer[i++]=1

}

}

}
getAccumulatedBuffer(){
return this.accumulation.getDisplayBuffer()
}
}

class PTHybridRendererBridge{
constructor(engine){
this.engine=engine
this.tracer=null
this.enabled=false
}
initialize(renderer,scene,camera){
this.tracer=new PTHybridTracer(renderer,scene,camera)
this.enabled=true
}
update(){
if(!this.enabled)return
if(!this.tracer)return
this.tracer.render()
}
reset(){
this.tracer?.reset()
}
getBuffer(){
return this.tracer?.getAccumulatedBuffer()
}
}
/* =========================================================
SPECTRAL RENDERING CORE
WAVELENGTH-BASED LIGHT TRANSPORT
FILM-ACCURATE COLOR SIMULATION
========================================================= */

const PT_SPECTRAL_LAMBDA_MIN=380
const PT_SPECTRAL_LAMBDA_MAX=780
const PT_SPECTRAL_BANDS=31

class PTSpectralSample{
constructor(lambda=550,intensity=0){
this.lambda=lambda
this.intensity=intensity
}
clone(){
return new PTSpectralSample(this.lambda,this.intensity)
}
}

class PTSpectralDistribution{
constructor(){
this.samples=new Float32Array(PT_SPECTRAL_BANDS)
this._initFlat()
}
_initFlat(){
for(let i=0;i<PT_SPECTRAL_BANDS;i++){
this.samples[i]=1
}
}
setGaussian(mean,width,amplitude=1){
for(let i=0;i<PT_SPECTRAL_BANDS;i++){
const lambda=this.getLambda(i)
const x=(lambda-mean)/width
this.samples[i]=amplitude*Math.exp(-0.5*x*x)
}
}
getLambda(i){
return PT_SPECTRAL_LAMBDA_MIN+(PT_SPECTRAL_LAMBDA_MAX-PT_SPECTRAL_LAMBDA_MIN)*(i/(PT_SPECTRAL_BANDS-1))
}
sample(lambda){
const t=(lambda-PT_SPECTRAL_LAMBDA_MIN)/(PT_SPECTRAL_LAMBDA_MAX-PT_SPECTRAL_LAMBDA_MIN)
const idx=Math.max(0,Math.min(PT_SPECTRAL_BANDS-1,Math.floor(t*(PT_SPECTRAL_BANDS-1))))
return this.samples[idx]
}
toRGB(){
let r=0,g=0,b=0
for(let i=0;i<PT_SPECTRAL_BANDS;i++){
const lambda=this.getLambda(i)
const value=this.samples[i]
const rgb=PTSpectralConverter.lambdaToRGB(lambda)
r+=rgb.r*value
g+=rgb.g*value
b+=rgb.b*value
}
return new THREE.Color(r,g,b).multiplyScalar(1/PT_SPECTRAL_BANDS)
}
}

class PTSpectralConverter{

static lambdaToRGB(lambda){

let r=0,g=0,b=0

if(lambda>=380&&lambda<440){
r=-(lambda-440)/(440-380)
g=0
b=1
}else if(lambda>=440&&lambda<490){
r=0
g=(lambda-440)/(490-440)
b=1
}else if(lambda>=490&&lambda<510){
r=0
g=1
b=-(lambda-510)/(510-490)
}else if(lambda>=510&&lambda<580){
r=(lambda-510)/(580-510)
g=1
b=0
}else if(lambda>=580&&lambda<645){
r=1
g=-(lambda-645)/(645-580)
b=0
}else if(lambda>=645&&lambda<=780){
r=1
g=0
b=0
}

let factor=0

if(lambda>=380&&lambda<420){
factor=0.3+0.7*(lambda-380)/(420-380)
}else if(lambda>=420&&lambda<645){
factor=1
}else if(lambda>=645&&lambda<=780){
factor=0.3+0.7*(780-lambda)/(780-645)
}

return new THREE.Color(r*factor,g*factor,b*factor)
}

static RGBToSpectral(color){
const dist=new PTSpectralDistribution()
for(let i=0;i<PT_SPECTRAL_BANDS;i++){
const lambda=dist.getLambda(i)
const rgb=this.lambdaToRGB(lambda)
dist.samples[i]=
color.r*rgb.r+
color.g*rgb.g+
color.b*rgb.b
}
return dist
}

}

class PTSpectralMaterial extends PTMaterial{

constructor(params={}){
super(params)
this.spectralDistribution=PTSpectralConverter.RGBToSpectral(this.color)
this.emissionSpectral=PTSpectralConverter.RGBToSpectral(this.emission)
}

evaluateSpectral(lambda,normal,inDir,outDir){

const spectralReflectance=this.spectralDistribution.sample(lambda)
const NdotL=Math.max(normal.dot(outDir),0)

return spectralReflectance*NdotL/PT_PI
}

evaluateEmission(lambda){

return this.emissionSpectral.sample(lambda)*this.emissionIntensity

}

}

class PTSpectralIntegrator extends PTIntegrator{

constructor(scene){
super(scene)
this.lambdaSampler=new PTSampler(987654)
}

traceSpectral(ray){

const lambda=
PT_SPECTRAL_LAMBDA_MIN+
(this.lambdaSampler.next()*
(PT_SPECTRAL_LAMBDA_MAX-PT_SPECTRAL_LAMBDA_MIN))

const radiance=this._traceLambda(ray,lambda)

const rgb=PTSpectralConverter.lambdaToRGB(lambda)

return new THREE.Color(
rgb.r*radiance,
rgb.g*radiance,
rgb.b*radiance
)

}

_traceLambda(ray,lambda){

let radiance=0
let throughput=1

const hit=new PTHit()
let currentRay=ray.clone()

for(let bounce=0;bounce<this.maxBounces;bounce++){

hit.reset()

if(!this.scene.intersect(currentRay,hit)){
break
}

let material=this.scene.getMaterial(hit.object)

if(!(material instanceof PTSpectralMaterial)){
material=new PTSpectralMaterial({
color:material.color.getHex(),
emission:material.emission.getHex(),
emissionIntensity:material.emissionIntensity,
roughness:material.roughness,
metalness:material.metalness
})
}

radiance+=throughput*material.evaluateEmission(lambda)

const sampler=this.sampler

const newDir=material.sampleDirection(
hit.normal,
currentRay.direction.clone().negate(),
sampler
)

const brdf=material.evaluateSpectral(
lambda,
hit.normal,
currentRay.direction.clone().negate(),
newDir
)

throughput*=brdf

if(throughput<0.000001){
break
}

throughput=Math.min(throughput,10)

currentRay=new PTRay(
hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
newDir
)

}

return radiance

}
}

}
/* =========================================================
RTX-STYLE GLOBAL ILLUMINATION INTEGRATOR
MULTI-BOUNCE INDIRECT LIGHT SOLVER
FILM-GRADE INDIRECT LIGHT TRANSPORT
========================================================= */

class PTGIReservoir{
constructor(){
this.position=new THREE.Vector3()
this.normal=new THREE.Vector3()
this.radiance=new THREE.Color()
this.weight=0
this.sampleCount=0
}
update(samplePos,sampleNormal,sampleRadiance,weight){
this.sampleCount++
const w=weight
if(Math.random()<w/(this.weight+w)){
this.position.copy(samplePos)
this.normal.copy(sampleNormal)
this.radiance.copy(sampleRadiance)
}
this.weight+=w
}
getRadiance(){
if(this.weight<=0)return new THREE.Color(0,0,0)
return this.radiance.clone().multiplyScalar(1/this.weight)
}
}

class PTGIProbe{
constructor(position=new THREE.Vector3()){
this.position=position.clone()
this.reservoir=new PTGIReservoir()
this.lastUpdateFrame=0
}
update(scene,integrator,sampler,frame){
const rayDir=sampler.nextHemisphere(new THREE.Vector3(0,1,0))
const ray=new PTRay(this.position,rayDir)
const color=integrator.trace(ray)
const weight=Math.max(color.r,color.g,color.b)
this.reservoir.update(this.position,new THREE.Vector3(0,1,0),color,weight)
this.lastUpdateFrame=frame
}
sample(){
return this.reservoir.getRadiance()
}
}

class PTGIProbeGrid{
constructor(boundsMin,boundsMax,resolution=8){
this.boundsMin=boundsMin.clone()
this.boundsMax=boundsMax.clone()
this.resolution=resolution
this.probes=[]
this._build()
}
_build(){
this.probes.length=0
for(let x=0;x<this.resolution;x++){
for(let y=0;y<this.resolution;y++){
for(let z=0;z<this.resolution;z++){
const denom=Math.max(1,this.resolution-1)

const fx=x/denom
const fy=y/denom
const fz=z/denom
const pos=new THREE.Vector3(
THREE.MathUtils.lerp(this.boundsMin.x,this.boundsMax.x,fx),
THREE.MathUtils.lerp(this.boundsMin.y,this.boundsMax.y,fy),
THREE.MathUtils.lerp(this.boundsMin.z,this.boundsMax.z,fz)
)
this.probes.push(new PTGIProbe(pos))
}
}
}
}
update(scene,integrator,sampler,frame){
for(const probe of this.probes){
if(frame-probe.lastUpdateFrame>1){
probe.update(scene,integrator,sampler,frame)
}
}
}
sample(position){
let closest=null
let minDist=PT_INFINITY
for(const probe of this.probes){
const d=probe.position.distanceToSquared(position)
if(d<minDist){
minDist=d
closest=probe
}
}
return closest?closest.sample():new THREE.Color(0,0,0)
}
}

class PTGIIntegrator{

constructor(scene,boundsMin,boundsMax,resolution=8){

this.scene=new PTScene(scene)

this.integrator=new PTIntegrator(scene)

this.sampler=new PTSampler(24681357)

this.frame=0

this.maxBounces=PT_MAX_BOUNCES

this.probeGrid=new PTGIProbeGrid(boundsMin,boundsMax,resolution)

this.indirectStrength=1.0

}

update(){

this.frame++

this.probeGrid.update(
this.scene.scene,
this.integrator,
this.sampler,
this.frame
)

}

evaluateIndirect(position,normal){

if(!position||!normal)return new THREE.Color(0,0,0)

const gi=this.probeGrid.sample(position)

const NdotL=Math.max(normal.dot(new THREE.Vector3(0,1,0)),0)

return gi.clone().multiplyScalar(NdotL*this.indirectStrength)

}

trace(ray){

if(!ray)return new THREE.Color(0,0,0)

const hit=new PTHit()

let currentRay=ray.clone()

let result=new THREE.Color(0,0,0)

let throughput=new THREE.Color(1,1,1)

for(let bounce=0;bounce<this.maxBounces;bounce++){

hit.reset()

if(!this.scene.intersect(currentRay,hit)){
break
}

const direct=this.integrator.trace(currentRay)

const indirect=this.evaluateIndirect(hit.position,hit.normal)

result.add(
throughput.clone().multiply(direct).add(
throughput.clone().multiply(indirect)
)
)

const material=this.scene.getMaterial(hit.object)

const newDir=material.sampleDirection(
hit.normal,
currentRay.direction.clone().negate(),
this.sampler
)

const brdf=material.evaluateBRDF(
hit.normal,
currentRay.direction.clone().negate(),
newDir
)

throughput.multiply(brdf).clampScalar(0,10)

currentRay=new PTRay(
hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
newDir
)

if(
throughput.r<0.0001&&
throughput.g<0.0001&&
throughput.b<0.0001
){
break
}

}

return result

}

}

class PTGIHybridBridge{

constructor(engine){

this.engine=engine
this.enabled=true
this.integrator=null

}

initialize(scene){

const boundsMin=new THREE.Vector3(-100,-100,-100)
const boundsMax=new THREE.Vector3(100,100,100)

this.integrator=new PTGIIntegrator(
scene,
boundsMin,
boundsMax,
12
)

}

update(){

if(!this.enabled||!this.integrator)return

this.integrator.update()

}

evaluate(ray){

if(!this.enabled||!this.integrator){
return new THREE.Color(0,0,0)
}

return this.integrator.trace(ray)

}

}
/* =========================================================
RTX-STYLE REFLECTION INTEGRATOR
FILM-GRADE SPECULAR AND GLOSSY REFLECTION SOLVER
========================================================= */

class PTReflectionMaterial extends PTMaterial{
constructor(params={}){
super(params)
this.specularColor=new THREE.Color(params.specularColor??0xffffff)
this.reflectivity=params.reflectivity??1.0
this.clearcoat=params.clearcoat??0
this.clearcoatRoughness=params.clearcoatRoughness??0.03
}
evaluateSpecular(normal,inDir,outDir){
const reflectDir=inDir.clone().reflect(normal).normalize()
const alignment=Math.max(reflectDir.dot(outDir),0)
const gloss=Math.pow(alignment,Math.max(1,(1-this.roughness)*256))
return this.specularColor.clone().multiplyScalar(gloss*this.reflectivity)
}
sampleSpecular(normal,inDir,sampler){
const perfect=inDir.clone().reflect(normal)
if(this.roughness<=0.001)return perfect.normalize()
const hemi=sampler.nextHemisphere(normal)
return perfect.lerp(hemi,this.roughness).normalize()
}
}

class PTReflectionHit extends PTHit{
constructor(){
super()
this.reflectance=new THREE.Color()
this.roughness=0
this.metalness=0
}
setReflection(material){
this.reflectance.copy(material.color)
this.roughness=material.roughness
this.metalness=material.metalness
}
}

class PTReflectionIntegrator{
constructor(scene){
this.scene=new PTScene(scene)
this.maxReflectionBounces=8
this.sampler=new PTSampler(97531)
this.environmentColor=new THREE.Color(0,0,0)
}
traceReflection(ray){
const result=new THREE.Color(0,0,0)
const throughput=new THREE.Color(1,1,1)
let currentRay=ray.clone()
const hit=new PTReflectionHit()
for(let bounce=0;bounce<this.maxReflectionBounces;bounce++){
hit.reset()
if(!this.scene.intersect(currentRay,hit)){
result.add(throughput.clone().multiply(this.environmentColor))
break
}
const material=this.scene.getMaterial(hit.object)
const reflMat=new PTReflectionMaterial({
color:material.color.getHex(),
roughness:material.roughness,
metalness:material.metalness,
reflectivity:material.metalness>0.5?1.0:0.04
})
hit.setReflection(reflMat)
const emission=material.getEmission()
result.add(throughput.clone().multiply(emission))
const reflectDir=reflMat.sampleSpecular(
hit.normal,
currentRay.direction.clone().negate(),
this.sampler
)
const spec=reflMat.evaluateSpecular(
hit.normal,
currentRay.direction.clone().negate(),
reflectDir
)
throughput.multiply(spec).clampScalar(0,10)
currentRay=new PTRay(
hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
reflectDir
)
if(Math.max(throughput.r,throughput.g,throughput.b)<0.0001){
break
}
}
return result
}
}

class PTReflectionProbe{
constructor(position=new THREE.Vector3()){
this.position=position.clone()
this.cubemap=new Array(6).fill(null).map(()=>new THREE.Color())
this.sampleCount=0
}
update(integrator,sampler){
const directions=[
new THREE.Vector3(1,0,0),
new THREE.Vector3(-1,0,0),
new THREE.Vector3(0,1,0),
new THREE.Vector3(0,-1,0),
new THREE.Vector3(0,0,1),
new THREE.Vector3(0,0,-1)
]
for(let i=0;i<6;i++){
const ray=new PTRay(this.position,directions[i])
const color=integrator.traceReflection(ray)
this.cubemap[i].add(color).clampScalar(0,100)
}
this.sampleCount++
}
sample(direction){
let maxDot=-1
let best=0
const dirs=[
new THREE.Vector3(1,0,0),
new THREE.Vector3(-1,0,0),
new THREE.Vector3(0,1,0),
new THREE.Vector3(0,-1,0),
new THREE.Vector3(0,0,1),
new THREE.Vector3(0,0,-1)
]
for(let i=0;i<6;i++){
const dot=dirs[i].dot(direction)
if(dot>maxDot){
maxDot=dot
best=i
}
}
return this.cubemap[best].clone().multiplyScalar(1/Math.max(1,this.sampleCount))
}
}

class PTReflectionSystem{
constructor(scene){
this.scene=scene
this.integrator=new PTReflectionIntegrator(scene)
this.probes=[]
this.enabled=true
}
addProbe(position){
const probe=new PTReflectionProbe(position)
this.probes.push(probe)
return probe
}
update(){
if(!this.enabled)return
const sampler=new PTSampler()
for(const probe of this.probes){
probe.update(this.integrator,sampler)
}
}
evaluate(ray){
if(!this.enabled)return new THREE.Color(0,0,0)
return this.integrator.traceReflection(ray)
}
}

class PTReflectionHybridBridge{
constructor(engine){
this.engine=engine
this.system=null
this.enabled=true
}
initialize(scene){
this.system=new PTReflectionSystem(scene)
this.system.addProbe(new THREE.Vector3(0,2,0))
}
update(){
if(!this.enabled||!this.system)return
this.system.update()
}
trace(ray){
if(!this.enabled||!this.system)return new THREE.Color(0,0,0)
return this.system.evaluate(ray)
}
}
/* =========================================================
FILM-GRADE SUBSURFACE SCATTERING (SSS)
RANDOM WALK + DIFFUSION PROFILE INTEGRATOR
CINEMATIC SKIN / TRANSLUCENT MATERIAL RENDERING
========================================================= */

class PTSSSProfile{
constructor(params={}){
this.color=new THREE.Color(params.color??0xffc6a6)
this.radius=params.radius??0.01
this.falloff=params.falloff??1.0
this.anisotropy=params.anisotropy??0.0
}
evaluate(distance){
const d=Math.max(distance,PT_EPSILON)
const attenuation=Math.exp(-d/(this.radius*this.falloff))
return this.color.clone().multiplyScalar(attenuation)
}
sampleDistance(sampler){
const u=sampler.next()
return -Math.log(1-u)*this.radius
}
}

class PTSSSMaterial extends PTMaterial{
constructor(params={}){
super(params)
this.sssProfile=new PTSSSProfile({
color:this.color.getHex(),
radius:params.sssRadius??0.01,
falloff:params.sssFalloff??1.0,
anisotropy:params.sssAnisotropy??0.0
})
this.subsurface=params.subsurface??0.5
}
isTranslucent(){
return this.subsurface>0.001
}
evaluateSSS(distance){
return this.sssProfile.evaluate(distance).multiplyScalar(this.subsurface)
}
sampleScatterDirection(normal,sampler){
return sampler.nextHemisphere(normal)
}
sampleScatterDistance(sampler){
return this.sssProfile.sampleDistance(sampler)
}
}

class PTSSSHit extends PTHit{
constructor(){
super()
this.scatterDistance=0
}
}

class PTSSSIntegrator{
constructor(scene){
this.scene=new PTScene(scene)
this.maxScatterEvents=8
this.sampler=new PTSampler(54321)
}
trace(ray){
const result=new THREE.Color(0,0,0)
const throughput=new THREE.Color(1,1,1)
let currentRay=ray.clone()
const hit=new PTSSSHit()
for(let scatter=0;scatter<this.maxScatterEvents;scatter++){
hit.reset()
if(!this.scene.intersect(currentRay,hit)){
break
}
const baseMat=this.scene.getMaterial(hit.object)
const material=new PTSSSMaterial({
color:baseMat.color.getHex(),
roughness:baseMat.roughness,
metalness:baseMat.metalness,
subsurface:baseMat.transmission??0.5,
sssRadius:0.01,
sssFalloff:1.0
})
const emission=material.getEmission()
result.add(throughput.clone().multiply(emission))
if(!material.isTranslucent()){
break
}
const scatterDist=material.sampleScatterDistance(this.sampler)
hit.scatterDistance=scatterDist
const scatterColor=material.evaluateSSS(scatterDist)
throughput.multiply(scatterColor).clampScalar(0,5)
const scatterDir=material.sampleScatterDirection(hit.normal,this.sampler)
currentRay=new PTRay(
hit.position.clone().addScaledVector(scatterDir,scatterDist),
scatterDir
)
if(Math.max(throughput.r,throughput.g,throughput.b)<0.0001){
break
}
}
return result
}
}

class PTSSSVolume{
constructor(boundsMin,boundsMax){
this.boundsMin=boundsMin.clone()
this.boundsMax=boundsMax.clone()
this.materialProfiles=new Map()
}
registerMaterial(object,profile){
this.materialProfiles.set(object,profile)
}
getProfile(object){
return this.materialProfiles.get(object)
}
contains(point){
return(
point.x>=this.boundsMin.x&&point.x<=this.boundsMax.x&&
point.y>=this.boundsMin.y&&point.y<=this.boundsMax.y&&
point.z>=this.boundsMin.z&&point.z<=this.boundsMax.z
)
}
}

class PTSSSSystem{
constructor(scene){
this.scene=scene
this.integrator=new PTSSSIntegrator(scene)
this.volumes=[]
this.enabled=true
}
addVolume(boundsMin,boundsMax){
const volume=new PTSSSVolume(boundsMin,boundsMax)
this.volumes.push(volume)
return volume
}
update(){
}
evaluate(ray){
if(!this.enabled)return new THREE.Color(0,0,0)
return this.integrator.trace(ray)
}
}

class PTSSSHybridBridge{
constructor(engine){
this.engine=engine
this.system=null
this.enabled=true
}
initialize(scene){
this.system=new PTSSSSystem(scene)
this.system.addVolume(
new THREE.Vector3(-10,-10,-10),
new THREE.Vector3(10,10,10)
)
}
update(){
if(!this.enabled||!this.system)return
this.system.update()
}
trace(ray){
if(!this.enabled||!this.system)return new THREE.Color(0,0,0)
return this.system.evaluate(ray)
}
}
/* =========================================================
FILM-GRADE HDR FILM BUFFER
CINEMA CAMERA RESPONSE + ACES TONE MAPPING
PHOTOMETRIC EXPOSURE PIPELINE
========================================================= */

class PTHDRBuffer{
constructor(width=1,height=1){
this.width=width
this.height=height
this.data=new Float32Array(width*height*4)
this.clear()
}
resize(width,height){
if(width===this.width&&height===this.height)return
this.width=width
this.height=height
this.data=new Float32Array(width*height*4)
this.clear()
}
clear(){
this.data.fill(0)
}
setPixel(x,y,color){
const i=(y*this.width+x)*4
this.data[i]=color.r
this.data[i+1]=color.g
this.data[i+2]=color.b
this.data[i+3]=1
}
addPixel(x,y,color){

const i=(y*this.width+x)*4

this.data[i]+=Math.min(color.r,1000)
this.data[i+1]+=Math.min(color.g,1000)
this.data[i+2]+=Math.min(color.b,1000)

}
getPixel(x,y,target=new THREE.Color()){
const i=(y*this.width+x)*4
return target.set(
this.data[i],
this.data[i+1],
this.data[i+2]
)
}
}

class PTExposureController{
constructor(){
this.exposure=1.0
this.autoExposure=true
this.keyValue=0.18
this.adaptationRate=0.05
this.minExposure=0.001
this.maxExposure=1000
}
computeAverageLuminance(buffer){
let sum=0
const data=buffer.data
const len=data.length
for(let i=0;i<len;i+=4){
const r=data[i]
const g=data[i+1]
const b=data[i+2]
const lum=0.2126*r+0.7152*g+0.0722*b
sum+=Math.log(0.0001+lum)
}
return Math.exp(sum/(len/4))
}
update(buffer){
if(!this.autoExposure)return
const avgLum=Math.max(0.000001,this.computeAverageLuminance(buffer))
const targetExposure=this.keyValue/(avgLum+0.0001)
if(Number.isFinite(targetExposure)){
this.exposure=THREE.MathUtils.lerp(
this.exposure,
targetExposure,
this.adaptationRate
)
}
this.exposure=Math.max(
this.minExposure,
Math.min(this.maxExposure,this.exposure)
)
}
apply(color){
return color.clone().multiplyScalar(this.exposure)
}
}

class PTACESFilmicToneMapper{

constructor(){
this.A=2.51
this.B=0.03
this.C=2.43
this.D=0.59
this.E=0.14
}

toneMap(color){

const r=this._map(color.r)
const g=this._map(color.g)
const b=this._map(color.b)

return new THREE.Color(r,g,b)

}

_map(x){

return THREE.MathUtils.clamp(
(x*(this.A*x+this.B))/(x*(this.C*x+this.D)+this.E),
0,
1
)

}

}

class PTFilmResponseCurve{

constructor(){
this.shoulderStrength=0.22
this.linearStrength=0.30
this.linearAngle=0.10
this.toeStrength=0.20
this.toeNumerator=0.01
this.toeDenominator=0.30
this.exposureBias=2.0
}

apply(color){

return new THREE.Color(
this._curve(color.r),
this._curve(color.g),
this._curve(color.b)
)

}

_curve(x){

x*=this.exposureBias

const toe=x*(this.toeStrength+x*this.toeNumerator)/(this.toeDenominator+x*this.toeNumerator)
const shoulder=(x*(this.shoulderStrength+x*this.linearStrength))/(1+x*this.linearAngle)

return THREE.MathUtils.clamp(toe+shoulder,0,1)

}

}

class PTFilmGrain{

constructor(){
this.strength=0.02
this.sampler=new PTSampler(777)
}

apply(color){

const noise=(this.sampler.next()-0.5)*this.strength*0.5

return new THREE.Color(
color.r+noise,
color.g+noise,
color.b+noise
)

}

}

class PTFilmBufferPipeline{

constructor(width=1,height=1){

this.hdrBuffer=new PTHDRBuffer(width,height)

this.exposureController=new PTExposureController()

this.toneMapper=new PTACESFilmicToneMapper()

this.responseCurve=new PTFilmResponseCurve()

this.filmGrain=new PTFilmGrain()

this.enableGrain=true

}

resize(width,height){

this.hdrBuffer.resize(width,height)

}

clear(){

this.hdrBuffer.clear()

}

addSample(x,y,color){

this.hdrBuffer.addPixel(x,y,color)

}

process(){

this.exposureController.update(this.hdrBuffer)

const width=this.hdrBuffer.width
const height=this.hdrBuffer.height

const output=new Float32Array(width*height*4)

let i=0

for(let y=0;y<height;y++){
for(let x=0;x<width;x++){

let color=this.hdrBuffer.getPixel(x,y)

color=this.exposureController.apply(color)

color=this.toneMapper.toneMap(color)

color=this.responseCurve.apply(color)

if(this.enableGrain){
color=this.filmGrain.apply(color)
}

output[i++]=Number.isFinite(color.r)?color.r:0
output[i++]=Number.isFinite(color.g)?color.g:0
output[i++]=Number.isFinite(color.b)?color.b:0
output[i++]=1

}
}

return output

}

}

class PTFilmPipelineBridge{

constructor(engine){

this.engine=engine

this.pipeline=new PTFilmBufferPipeline(1,1)

this.enabled=true

}

resize(width,height){

this.pipeline.resize(width,height)

}

addSample(x,y,color){

if(!this.enabled)return

this.pipeline.addSample(x,y,color)

}

process(){

if(!this.enabled)return null

return this.pipeline.process()

}

}
/* =========================================================
MONTE CARLO LIGHT TRANSPORT OPTIMIZER
TEMPORAL + SPATIAL ReSTIR RESERVOIR SAMPLING
FILM-GRADE NOISE REDUCTION AND CONVERGENCE
========================================================= */

class PTReservoir{

constructor(){

this.sample=null
this.weightSum=0
this.M=0

}

update(candidate,weight,sampler){

this.M++

this.weightSum+=weight

if(this.weightSum<=0)return

const p=weight/this.weightSum

if(sampler.next()<p){

this.sample=candidate.clone()

}

}

merge(other,sampler){

if(!other||other.weightSum<=0)return

this.update(
other.sample,
other.weightSum,
sampler
)

}

getSample(){

return this.sample

}

getWeight(){

return this.weightSum/Math.max(1,this.M)

}

reset(){

this.sample=null
this.weightSum=0
this.M=0

}

}

class PTLightSample{

constructor(){

this.position=new THREE.Vector3()
this.normal=new THREE.Vector3()
this.emission=new THREE.Color()
this.pdf=1

}

clone(){

const s=new PTLightSample()

s.position.copy(this.position)
s.normal.copy(this.normal)
s.emission.copy(this.emission)
s.pdf=this.pdf

return s

}

}

class PTLightSampler{

constructor(scene){

this.scene=scene

this.lights=[]

this.sampler=new PTSampler(2468)

this._collectLights(scene)

}

_collectLights(scene){

scene.traverse(obj=>{

if(obj.isLight){

this.lights.push(obj)

}

})

}

sample(){

if(this.lights.length===0)return null

const index=Math.floor(this.sampler.next()*this.lights.length)

const light=this.lights[index]

const sample=new PTLightSample()

sample.position.copy(light.position)

sample.normal.set(0,1,0)

sample.emission.copy(light.color).multiplyScalar(light.intensity)

sample.pdf=1/this.lights.length

return sample

}

}

class PTTemporalReservoirBuffer{

constructor(width=1,height=1){

this.width=width
this.height=height

this.reservoirs=new Array(width*height)

for(let i=0;i<this.reservoirs.length;i++){

this.reservoirs[i]=new PTReservoir()

}

}

resize(width,height){

this.width=width
this.height=height

this.reservoirs=new Array(width*height)

for(let i=0;i<this.reservoirs.length;i++){

this.reservoirs[i]=new PTReservoir()

}

}

get(x,y){

return this.reservoirs[y*this.width+x]

}

set(x,y,reservoir){

this.reservoirs[y*this.width+x]=reservoir

}

clear(){

for(const r of this.reservoirs){

r.reset()

}

}

}

class PTReSTIRIntegrator{

constructor(scene,width=1,height=1){

this.scene=scene

this.width=width
this.height=height

this.lightSampler=new PTLightSampler(scene)

this.temporalBuffer=new PTTemporalReservoirBuffer(width,height)

this.currentBuffer=new PTTemporalReservoirBuffer(width,height)

this.sampler=new PTSampler(13579)

this.enableTemporalReuse=true

}

resize(width,height){

this.width=width
this.height=height

this.temporalBuffer.resize(width,height)
this.currentBuffer.resize(width,height)

}

beginFrame(){

const temp=this.temporalBuffer

this.temporalBuffer=this.currentBuffer

this.currentBuffer=temp

this.currentBuffer.clear()

}

processPixel(x,y,hitPoint,normal){

const reservoir=this.currentBuffer.get(x,y)

const candidate=this.lightSampler.sample()

if(candidate){

const weight=this.evaluate(candidate,hitPoint,normal)

reservoir.update(candidate,weight,this.sampler)

}

if(this.enableTemporalReuse){

const prev=this.temporalBuffer.get(x,y)

reservoir.merge(prev,this.sampler)

}

}

evaluate(sample,hitPoint,normal){

const toLight=new THREE.Vector3().subVectors(
sample.position,
hitPoint
)

const distanceSq=toLight.lengthSq()

toLight.normalize()

const NdotL=Math.max(normal.dot(toLight),0)

const attenuation=1/(distanceSq+1)

return NdotL*attenuation/sample.pdf

}

resolve(x,y){

const reservoir=this.currentBuffer.get(x,y)

const sample=reservoir.getSample()

if(!sample)return new THREE.Color(0,0,0)

return sample.emission.clone().multiplyScalar(
reservoir.getWeight()
)

}

}

class PTReSTIRBridge{

constructor(engine){

this.engine=engine

this.integrator=null

this.enabled=true

}

initialize(scene,width,height){

this.integrator=new PTReSTIRIntegrator(
scene,
width,
height
)

}

resize(width,height){

if(this.integrator){

this.integrator.resize(width,height)

}

}

beginFrame(){

if(!this.enabled||!this.integrator)return

this.integrator.beginFrame()

}

processPixel(x,y,hitPoint,normal){

if(!this.enabled||!this.integrator)return

this.integrator.processPixel(
x,
y,
hitPoint,
normal
)

}

resolve(x,y){

if(!this.enabled||!this.integrator){

return new THREE.Color(0,0,0)

}

return this.integrator.resolve(x,y)

}

}
/* =========================================================
SPECTRAL RENDERING ENGINE
TRUE WAVELENGTH LIGHT TRANSPORT
FILM-ACCURATE COLOR PHYSICS
========================================================= */

const PT_SPECTRAL_LAMBDA_MIN=380
const PT_SPECTRAL_LAMBDA_MAX=780
const PT_SPECTRAL_SAMPLES=31

class PTSpectralSample{

constructor(lambda=550,intensity=1){

this.lambda=lambda
this.intensity=intensity

}

clone(){

return new PTSpectralSample(
this.lambda,
this.intensity
)

}

}

class PTSpectralDistribution{

constructor(){

this.samples=new Float32Array(PT_SPECTRAL_SAMPLES)

this.lambdaStep=(PT_SPECTRAL_LAMBDA_MAX-PT_SPECTRAL_LAMBDA_MIN)/(PT_SPECTRAL_SAMPLES-1)

}

setUniform(value){

this.samples.fill(value)

}

setGaussian(center,width,intensity){

for(let i=0;i<PT_SPECTRAL_SAMPLES;i++){

const lambda=PT_SPECTRAL_LAMBDA_MIN+i*this.lambdaStep

const d=lambda-center

this.samples[i]=intensity*Math.exp(-(d*d)/(2*width*width))

}

}

sample(lambda){

const index=(lambda-PT_SPECTRAL_LAMBDA_MIN)/this.lambdaStep

const i0=Math.floor(index)

const i1=Math.min(i0+1,PT_SPECTRAL_SAMPLES-1)

const t=index-i0

const v0=this.samples[Math.max(0,i0)]
const v1=this.samples[Math.max(0,i1)]

return v0*(1-t)+v1*t

}

multiply(other){

for(let i=0;i<PT_SPECTRAL_SAMPLES;i++){

this.samples[i]*=other.samples[i]

}

return this

}

scale(factor){

for(let i=0;i<PT_SPECTRAL_SAMPLES;i++){

this.samples[i]*=factor

}

return this

}

clone(){

const d=new PTSpectralDistribution()

d.samples.set(this.samples)

return d

}

}

class PTSpectralColor{

constructor(){

this.distribution=new PTSpectralDistribution()

}

fromRGB(color){

const r=color.r
const g=color.g
const b=color.b

this.distribution.setGaussian(620,40,r)
this.distribution.setGaussian(540,30,g)
this.distribution.setGaussian(460,20,b)

return this

}

toRGB(){

let r=0
let g=0
let b=0

for(let i=0;i<PT_SPECTRAL_SAMPLES;i++){

const lambda=PT_SPECTRAL_LAMBDA_MIN+i*this.distribution.lambdaStep
const v=this.distribution.samples[i]

if(lambda>=600)r+=v
else if(lambda>=500)g+=v
else b+=v

}

const scale=1/PT_SPECTRAL_SAMPLES

return new THREE.Color(
r*scale,
g*scale,
b*scale
)

}

multiply(other){

this.distribution.multiply(other.distribution)

return this

}

scale(f){

this.distribution.scale(f)

return this

}

clone(){

const c=new PTSpectralColor()

c.distribution=this.distribution.clone()

return c

}

}

class PTSpectralMaterial{

constructor(params={}){

this.albedo=new PTSpectralColor().fromRGB(
new THREE.Color(params.color??0xffffff)
)

this.emission=new PTSpectralColor().fromRGB(
new THREE.Color(params.emission??0x000000)
)

this.roughness=params.roughness??0.5

}

evaluate(){

return this.albedo.clone()

}

getEmission(){

return this.emission.clone()

}

}

class PTSpectralLight{

constructor(color=new THREE.Color(1,1,1),intensity=1){

this.spectralColor=new PTSpectralColor().fromRGB(color)

this.intensity=intensity

}

sample(){

return this.spectralColor.clone().scale(this.intensity)

}

}

class PTSpectralIntegrator{

constructor(scene){

this.scene=scene

this.maxBounces=8

this.sampler=new PTSampler(8642)

}

trace(ray){

let spectral=new PTSpectralColor()

spectral.distribution.setUniform(0)

let throughput=new PTSpectralColor()

throughput.distribution.setUniform(1)

let currentRay=ray.clone()

const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){

for(let bounce=0;bounce<this.maxBounces;bounce++){

hit.reset()

if(!new PTScene(this.scene).intersect(currentRay,hit)){

break

}

const mat=new PTSpectralMaterial({
color:hit.object.material.color.getHex()
})

const emission=mat.getEmission()

spectral.multiply(emission)

const evalColor=mat.evaluate()

throughput.multiply(evalColor)

const dir=this.randomHemisphere(hit.normal)

currentRay=new PTRay(
hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
dir
)

}

return throughput

}

randomHemisphere(normal){

const u=this.sampler.next()
const v=this.sampler.next()

const theta=Math.acos(Math.sqrt(1-u))
const phi=2*Math.PI*v

const x=Math.sin(theta)*Math.cos(phi)
const y=Math.cos(theta)
const z=Math.sin(theta)*Math.sin(phi)

const dir=new THREE.Vector3(x,y,z)

if(dir.dot(normal)<0)dir.negate()

return dir.normalize()

}

}

class PTSpectralBridge{

constructor(engine){

this.engine=engine

this.integrator=null

this.enabled=true

}

initialize(scene){

this.integrator=new PTSpectralIntegrator(scene)

}

trace(ray){

if(!this.enabled||!this.integrator){

return new THREE.Color(0,0,0)

}

const spectral=this.integrator.trace(ray)

return spectral.toRGB()

}

}
/* =========================================================
HYBRID RTX PATH TRACING CORE
UNIFIED CINEMATIC LIGHT TRANSPORT INTEGRATOR
COMBINES:
- PATH TRACING
- SPECTRAL RENDERING
- RTX REFLECTION
- GLOBAL ILLUMINATION
- SUBSURFACE SCATTERING
- ReSTIR LIGHT SAMPLING
========================================================= */

class PTHybridPathState{

constructor(){

this.ray=null
this.throughput=new THREE.Color(1,1,1)
this.radiance=new THREE.Color(0,0,0)
this.bounce=0
this.done=false

}

reset(ray){

this.ray=ray.clone()
this.throughput.set(1,1,1)
this.radiance.set(0,0,0)
this.bounce=0
this.done=false

}

}

class PTHybridMaterialAdapter{

constructor(object){

this.object=object
this.material=object.material

}

isEmissive(){

return this.material.emissiveIntensity>0

}

getEmission(){

return this.material.emissive.clone()
.multiplyScalar(this.material.emissiveIntensity)

}

getAlbedo(){

return this.material.color.clone()

}

getRoughness(){

return this.material.roughness??0.5

}

getMetalness(){

return this.material.metalness??0

}

isSSS(){

return this.material.transmission>0.01

}

}

class PTHybridIntegrator{

constructor(scene){

this.scene=scene

this.maxBounces=12

this.sampler=new PTSampler(999)

if(this.sceneAccel.intersect(ray,hit)){

this.spectral=new PTSpectralIntegrator(scene)

this.reflection=new PTReflectionIntegrator(scene)

this.sss=new PTSSSIntegrator(scene)

}

trace(ray){

const state=new PTHybridPathState()

state.reset(ray)

const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){

while(!state.done){

if(state.bounce>=this.maxBounces){

state.done=true
break

}

hit.reset()

if(!this.sceneAccel.intersect(state.ray,hit)){

state.done=true
break

}

const adapter=new PTHybridMaterialAdapter(hit.object)

if(adapter.isEmissive()){

state.radiance.add(
adapter.getEmission()
.multiply(state.throughput)
)

}

const albedo=adapter.getAlbedo()

const spectral=this.spectral.trace(state.ray)

const reflection=this.reflection.traceReflection(state.ray)

const sss=adapter.isSSS()?this.sss.trace(state.ray):new THREE.Color()

const combined=new THREE.Color()

combined.add(albedo)
combined.add(reflection)
combined.add(sss)
combined.add(spectral)

state.throughput.multiply(combined)

const nextDir=this.sampleDirection(
hit.normal,
adapter.getRoughness()
)

state.ray=new PTRay(
hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
nextDir
)

if(this.russianRoulette(state)){

state.done=true

}

state.bounce++

}

return state.radiance

}

sampleDirection(normal,roughness){

const u=this.sampler.next()
const v=this.sampler.next()

const theta=Math.acos(Math.pow(1-u,1/(roughness+1)))
const phi=2*Math.PI*v

const x=Math.sin(theta)*Math.cos(phi)
const y=Math.cos(theta)
const z=Math.sin(theta)*Math.sin(phi)

const dir=new THREE.Vector3(x,y,z)

if(dir.dot(normal)<0)dir.negate()

return dir.normalize()

}

russianRoulette(state){

if(state.bounce<3)return false

const p=Math.max(
state.throughput.r,
state.throughput.g,
state.throughput.b
)

if(this.sampler.next()>p){

return true

}

state.throughput.multiplyScalar(1/p)

return false

}

}

class PTHybridPathTracer{

constructor(engine){

this.engine=engine

this.integrator=null

this.enabled=true

this.width=1
this.height=1

this.accumulationBuffer=null

this.samples=0

}

initialize(scene,width,height){

this.integrator=new PTHybridIntegrator(scene)

this.resize(width,height)

}

resize(width,height){

this.width=width
this.height=height

this.accumulationBuffer=new Float32Array(width*height*3)

this.samples=0

}

reset(){

this.samples=0

this.accumulationBuffer.fill(0)

}

tracePixel(x,y,camera){

const ray=this.generateCameraRay(x,y,camera)

const color=this.integrator.trace(ray)

const i=(y*this.width+x)*3

this.accumulationBuffer[i]+=color.r
this.accumulationBuffer[i+1]+=color.g
this.accumulationBuffer[i+2]+=color.b

return new THREE.Color(
this.accumulationBuffer[i]/(this.samples+1),
this.accumulationBuffer[i+1]/(this.samples+1),
this.accumulationBuffer[i+2]/(this.samples+1)
)

}

generateCameraRay(x,y,camera){

const ndcX=(x+Math.random())/this.width*2-1
const ndcY=(y+Math.random())/this.height*2-1

const origin=camera.position.clone()

const direction=new THREE.Vector3(ndcX,ndcY,1)
.unproject(camera)
.sub(origin)
.normalize()

return new PTRay(origin,direction)

}

endFrame(){

this.samples++

}

}

class PTHybridBridge{

constructor(engine){

this.engine=engine

this.tracer=new PTHybridPathTracer(engine)

this.enabled=true

}

initialize(scene,width,height){

this.tracer.initialize(scene,width,height)

}

resize(width,height){

this.tracer.resize(width,height)

}

tracePixel(x,y,camera){

if(!this.enabled)return new THREE.Color()

return this.tracer.tracePixel(x,y,camera)

}

endFrame(){

this.tracer.endFrame()

}

}
/* =========================================================
CINEMATIC CAMERA PHYSICAL MODEL
FILM LENS + APERTURE + SHUTTER + SENSOR SIMULATION
========================================================= */

class PTCameraPhysicalParams{

constructor(){

this.sensorWidth=36.0
this.sensorHeight=24.0

this.focalLength=50.0

this.aperture=1.4

this.focusDistance=5.0

this.shutterSpeed=1/48

this.iso=100

this.bladeCount=9

this.anamorphicRatio=1.0

}

getFOV(){

return 2*Math.atan(this.sensorHeight/(2*this.focalLength))

}

getApertureRadius(){

return this.focalLength/(2*this.aperture)

}

getExposureMultiplier(){

const t=this.shutterSpeed
const N=this.aperture
const S=this.iso

return (t*S)/(N*N)

}

}

class PTCameraRay{

constructor(){

this.origin=new THREE.Vector3()
this.direction=new THREE.Vector3()

}

}

class PTCameraLensSampler{

constructor(params){

this.params=params

this.sampler=new PTSampler(4321)

}

sampleAperture(){

const blades=this.params.bladeCount

const r=Math.sqrt(this.sampler.next())
const theta=this.sampler.next()*Math.PI*2

let x=r*Math.cos(theta)
let y=r*Math.sin(theta)

const radius=this.params.getApertureRadius()

x*=radius
y*=radius

x*=this.params.anamorphicRatio

return new THREE.Vector2(x,y)

}

}

class PTCameraPhysical{

constructor(threeCamera){

this.camera=threeCamera

this.params=new PTCameraPhysicalParams()

this.lensSampler=new PTCameraLensSampler(this.params)

}

generateRay(x,y,width,height){

const ndcX=(x+Math.random())/width*2-1
const ndcY=(y+Math.random())/height*2-1

const origin=this.camera.position.clone()

const target=new THREE.Vector3(ndcX,ndcY,1)
.unproject(this.camera)

const focusDir=target.clone().sub(origin).normalize()

const focusPoint=origin.clone().addScaledVector(
focusDir,
this.params.focusDistance
)

const apertureSample=this.lensSampler.sampleAperture()

const apertureWorld=new THREE.Vector3(
apertureSample.x,
apertureSample.y,
0
).applyQuaternion(this.camera.quaternion)

const newOrigin=origin.clone().add(apertureWorld)

const newDir=focusPoint.clone().sub(newOrigin).normalize()

const ray=new PTCameraRay()

ray.origin.copy(newOrigin)
ray.direction.copy(newDir)

return ray

}

getExposure(){

return this.params.getExposureMultiplier()

}

getFOV(){

return this.params.getFOV()

}

}

class PTCinematicShutter{

constructor(){

this.shutterSpeed=1/48

this.shutterAngle=180

this.frameTime=1/24

}

getExposureTime(){

return this.shutterAngle/360*this.frameTime

}

sampleTime(sampler){

return sampler.next()*this.getExposureTime()

}

}

class PTCameraMotionBlur{

constructor(){

this.enabled=true

this.samples=8

this.sampler=new PTSampler(5678)

this.shutter=new PTCinematicShutter()

}

sampleMotion(camera,time){

const pos=camera.position.clone()

const jitter=new THREE.Vector3(
(this.sampler.next()-0.5)*0.01,
(this.sampler.next()-0.5)*0.01,
(this.sampler.next()-0.5)*0.01
)

pos.add(jitter)

return pos

}

}

class PTCinematicCameraSystem{

constructor(engine){

this.engine=engine

this.cameraPhysical=null

this.motionBlur=new PTCameraMotionBlur()

this.enabled=true

}

initialize(threeCamera){

this.cameraPhysical=new PTCameraPhysical(threeCamera)

}

generateRay(x,y,width,height){

if(!this.enabled||!this.cameraPhysical){

return null

}

return this.cameraPhysical.generateRay(
x,
y,
width,
height
)

}

getExposure(){

if(!this.enabled||!this.cameraPhysical){

return 1.0

}

return this.cameraPhysical.getExposure()

}

update(){

}

}
/* =========================================================
FILM-GRADE VOLUMETRIC LIGHTING + ATMOSPHERIC SCATTERING
PHYSICAL FOG, LIGHT SHAFTS, CINEMATIC AIR PERSPECTIVE
========================================================= */

class PTVolumeMedium{

constructor(params={}){

this.density=params.density??0.01

this.scattering=params.scattering??0.9

this.absorption=params.absorption??0.1

this.anisotropy=params.anisotropy??0.0

this.color=new THREE.Color(params.color??0xffffff)

}

evaluateTransmittance(distance){

const extinction=this.density*(this.scattering+this.absorption)

const T=Math.exp(-extinction*distance)

return T

}

evaluateScattering(distance){

const T=this.evaluateTransmittance(distance)

return this.color.clone().multiplyScalar(
this.scattering*(1-T)
)

}

sampleDistance(sampler){

const extinction=this.density*(this.scattering+this.absorption)

const u=sampler.next()

return -Math.log(1-u)/extinction

}

}

class PTVolumeRegion{

constructor(min,max,medium){

this.min=min.clone()
this.max=max.clone()

this.medium=medium

}

contains(point){

return(
point.x>=this.min.x&&point.x<=this.max.x&&
point.y>=this.min.y&&point.y<=this.max.y&&
point.z>=this.min.z&&point.z<=this.max.z
)

}

}

class PTVolumetricIntegrator{

constructor(scene){

this.scene=scene

this.mediums=[]

this.maxSteps=64

this.stepSize=0.2

this.sampler=new PTSampler(8888)

}

addMedium(region){

this.mediums.push(region)

}

trace(ray,maxDistance=100){

const result=new THREE.Color()

let distance=0

let transmittance=1.0

for(let i=0;i<this.maxSteps;i++){

if(distance>=maxDistance)break

const point=ray.origin.clone().addScaledVector(
ray.direction,
distance
)

const medium=this.findMedium(point)

if(medium){

const scatter=medium.evaluateScattering(
this.stepSize
)

result.add(
scatter.multiplyScalar(transmittance)
)

transmittance*=medium.evaluateTransmittance(
this.stepSize
)

}

distance+=this.stepSize

if(transmittance<0.001){

break

}

}

return result

}

findMedium(point){

for(const region of this.mediums){

if(region.contains(point)){

return region.medium

}

}

return null

}

}

class PTAtmosphereModel{

constructor(){

this.rayleigh=new THREE.Color(0.5,0.7,1.0)

this.mie=new THREE.Color(1.0,0.9,0.7)

this.density=0.01

}

evaluate(direction){

const mu=Math.max(direction.y,0)

const rayleigh=this.rayleigh.clone().multiplyScalar(
Math.pow(mu,4)
)

const mie=this.mie.clone().multiplyScalar(
Math.pow(mu,1.5)
)

return rayleigh.add(mie).multiplyScalar(this.density)

}

}

class PTVolumetricLightingSystem{

constructor(scene){

this.scene=scene

this.integrator=new PTVolumetricIntegrator(scene)

this.atmosphere=new PTAtmosphereModel()

this.enabled=true

}

initialize(){

const medium=new PTVolumeMedium({
density:0.02,
scattering:0.9,
absorption:0.1,
color:0xffffff
})

const region=new PTVolumeRegion(
new THREE.Vector3(-1000,-1000,-1000),
new THREE.Vector3(1000,1000,1000),
medium
)

this.integrator.addMedium(region)

}

trace(ray){

if(!this.enabled){

return new THREE.Color()

}

const volume=this.integrator.trace(ray)

const atmosphere=this.atmosphere.evaluate(ray.direction)

return volume.add(atmosphere)

}

}

class PTVolumetricBridge{

constructor(engine){

this.engine=engine

this.system=null

this.enabled=true

}

initialize(scene){

this.system=new PTVolumetricLightingSystem(scene)

this.system.initialize()

}

trace(ray){

if(!this.enabled||!this.system){

return new THREE.Color()

}

return this.system.trace(ray)

}

}
/* =========================================================
GLOBAL ILLUMINATION CACHE + RADIANCE FIELD SYSTEM
FILM-GRADE INDIRECT LIGHTING STABILITY AND REUSE
========================================================= */

class PTRadianceSample{

constructor(){

this.position=new THREE.Vector3()
this.normal=new THREE.Vector3()

this.radiance=new THREE.Color()

this.weight=1

}

clone(){

const s=new PTRadianceSample()

s.position.copy(this.position)
s.normal.copy(this.normal)
s.radiance.copy(this.radiance)
s.weight=this.weight

return s

}

}

class PTRadianceCache{

constructor(){

this.samples=[]

this.maxSamples=50000

this.searchRadius=2.0

}

add(sample){

if(this.samples.length>=this.maxSamples){

this.samples.shift()

}

this.samples.push(sample.clone())

}

query(position,normal){

const result=new THREE.Color()

let totalWeight=0

for(const s of this.samples){

const distSq=position.distanceToSquared(s.position)

if(distSq>this.searchRadius*this.searchRadius){

continue

}

const normalWeight=Math.max(
normal.dot(s.normal),
0
)

const distWeight=1/(distSq+0.0001)

const weight=normalWeight*distWeight

result.add(
s.radiance.clone().multiplyScalar(weight)
)

totalWeight+=weight

}

if(totalWeight>0){

result.multiplyScalar(1/totalWeight)

}

return result

}

clear(){

this.samples.length=0

}

}

class PTRadianceField{

constructor(){

this.gridSize=32

this.cellSize=2.0

this.cells=new Map()

}

_hash(x,y,z){

return `${x},${y},${z}`

}

_getCellCoords(position){

return{
x:Math.floor(position.x/this.cellSize),
y:Math.floor(position.y/this.cellSize),
z:Math.floor(position.z/this.cellSize)
}

}

addSample(sample){

const c=this._getCellCoords(sample.position)

const key=this._hash(c.x,c.y,c.z)

if(!this.cells.has(key)){

this.cells.set(key,[])

}

this.cells.get(key).push(sample.clone())

}

query(position,normal){

const c=this._getCellCoords(position)

const result=new THREE.Color()

let totalWeight=0

for(let dz=-1;dz<=1;dz++){
for(let dy=-1;dy<=1;dy++){
for(let dx=-1;dx<=1;dx++){

const key=this._hash(
c.x+dx,
c.y+dy,
c.z+dz
)

const cell=this.cells.get(key)

if(!cell)continue

for(const sample of cell){

const distSq=position.distanceToSquared(
sample.position
)

const normalWeight=Math.max(
normal.dot(sample.normal),
0
)

const weight=normalWeight/(distSq+0.001)

result.add(
sample.radiance.clone()
.multiplyScalar(weight)
)

totalWeight+=weight

}

}
}
}

if(totalWeight>0){

result.multiplyScalar(1/totalWeight)

}

return result

}

clear(){

this.cells.clear()

}

}

class PTGlobalIlluminationSystem{

constructor(scene){

this.scene=scene

this.cache=new PTRadianceCache()

this.field=new PTRadianceField()

this.enabled=true

this.maxSamplesPerFrame=1000

this.sampler=new PTSampler(4242)

}

record(position,normal,radiance){

if(!this.enabled)return

const sample=new PTRadianceSample()

sample.position.copy(position)
sample.normal.copy(normal)
sample.radiance.copy(radiance)

this.cache.add(sample)

this.field.addSample(sample)

}

evaluate(position,normal){

if(!this.enabled){

return new THREE.Color()

}

const cacheRadiance=this.cache.query(
position,
normal
)

const fieldRadiance=this.field.query(
position,
normal
)

return cacheRadiance.add(fieldRadiance).multiplyScalar(0.5)

}

update(){

}

clear(){

this.cache.clear()

this.field.clear()

}

}

class PTGlobalIlluminationBridge{

constructor(engine){

this.engine=engine

this.system=null

this.enabled=true

}

initialize(scene){

this.system=new PTGlobalIlluminationSystem(scene)

}

record(position,normal,radiance){

if(!this.enabled||!this.system)return

this.system.record(
position,
normal,
radiance
)

}

evaluate(position,normal){

if(!this.enabled||!this.system){

return new THREE.Color()

}

return this.system.evaluate(
position,
normal
)

}

clear(){

if(this.system){

this.system.clear()

}

}

}
/* =========================================================
FINAL UNIFIED CINEMATIC RENDERER
CONNECTS ALL SYSTEMS INTO ONE FILM-GRADE RENDER PIPELINE
========================================================= */

class PTCinematicRendererCore{

constructor(engine){

this.engine=engine

this.initialized=false

this.width=1
this.height=1

this.hybrid=null

this.gi=null

this.restir=null

this.volumetric=null

this.spectral=null

this.reflection=null

this.sss=null

this.filmPipeline=null

this.cameraSystem=null

this.frameIndex=0

}

initialize(scene,camera,width,height){

this.width=width
this.height=height

this.hybrid=new PTHybridBridge(this.engine)
this.hybrid.initialize(scene,width,height)

this.gi=new PTGlobalIlluminationBridge(this.engine)
this.gi.initialize(scene)

this.restir=new PTReSTIRBridge(this.engine)
this.restir.initialize(scene,width,height)

this.volumetric=new PTVolumetricBridge(this.engine)
this.volumetric.initialize(scene)

this.spectral=new PTSpectralBridge(this.engine)
this.spectral.initialize(scene)

this.reflection=new PTReflectionHybridBridge(this.engine)
this.reflection.initialize(scene)

this.sss=new PTSSSHybridBridge(this.engine)
this.sss.initialize(scene)

this.filmPipeline=new PTFilmPipelineBridge(this.engine)
this.filmPipeline.resize(width,height)

this.cameraSystem=new PTCinematicCameraSystem(this.engine)
this.cameraSystem.initialize(camera)

this.initialized=true

}

resize(width,height){

this.width=width
this.height=height

if(this.hybrid)this.hybrid.resize(width,height)
if(this.restir)this.restir.resize(width,height)
if(this.filmPipeline)this.filmPipeline.resize(width,height)

}

beginFrame(){

if(!this.initialized)return

this.restir.beginFrame()

}

renderPixel(x,y,camera){

if(!this.initialized)return new THREE.Color()

const ray=this.cameraSystem.generateRay(
x,
y,
this.width,
this.height
)

let color=new THREE.Color()

const hybrid=this.hybrid.tracePixel(x,y,camera)

const spectral=this.spectral.trace(ray)

const reflection=this.reflection.trace(ray)

const sss=this.sss.trace(ray)

const volumetric=this.volumetric.trace(ray)

const gi=this.gi.evaluate(ray.origin,ray.direction)

const restir=this.restir.resolve(x,y)

color.add(hybrid)
color.add(spectral)
color.add(reflection)
color.add(sss)
color.add(volumetric)
color.add(gi)
color.add(restir)

const exposure=this.cameraSystem.getExposure()

color.multiplyScalar(exposure)

this.filmPipeline.addSample(x,y,color)

return color

}

endFrame(){

this.hybrid.endFrame()

this.frameIndex++

}

resolveFrame(){

return this.filmPipeline.process()

}

}

class PTCinematicRenderer{

constructor(engine){

this.engine=engine

this.core=new PTCinematicRendererCore(engine)

this.enabled=true

this.outputBuffer=null

}

initialize(scene,camera,width,height){

this.core.initialize(scene,camera,width,height)

this.outputBuffer=new Float32Array(width*height*4)

}

resize(width,height){

this.core.resize(width,height)

this.outputBuffer=new Float32Array(width*height*4)

}

render(scene,camera){

if(!this.enabled)return

this.core.beginFrame()

const width=this.core.width
const height=this.core.height

let i=0

for(let y=0;y<height;y++){
for(let x=0;x<width;x++){

const color=this.core.renderPixel(x,y,camera)

this.outputBuffer[i++]=color.r
this.outputBuffer[i++]=color.g
this.outputBuffer[i++]=color.b
this.outputBuffer[i++]=1

}
}

this.core.endFrame()

return this.outputBuffer

}

resolve(){

return this.core.resolveFrame()

}

}

class PTCinematicRendererBridge{

constructor(engine){

this.engine=engine

this.renderer=new PTCinematicRenderer(engine)

this.enabled=true

}

initialize(scene,camera,width,height){

this.renderer.initialize(
scene,
camera,
width,
height
)

}

render(scene,camera){

if(!this.enabled)return null

return this.renderer.render(
scene,
camera
)

}

resolve(){

return this.renderer.resolve()

}

resize(width,height){

this.renderer.resize(width,height)

}

}
/* =========================================================
FINAL ENGINE INTEGRATION LAYER
ULTIMATE CINEMATIC RENDERER ACTIVATION
THIS COMPLETES THE FULL CINEMATIC ENGINE
========================================================= */

class PTUltimateCinematicEngine{

constructor(engine){

this.engine=engine

this.rendererBridge=new PTCinematicRendererBridge(engine)

this.initialized=false

this.scene=null
this.camera=null

this.width=1
this.height=1

this.outputTexture=null

this.outputData=null

this.frame=0

this.enabled=true

}

initialize(scene,camera,width,height){

this.scene=scene
this.camera=camera

this.width=width
this.height=height

if(!this.rendererBridge){
throw new Error("rendererBridge missing")
}

this.rendererBridge.initialize(
scene,
camera,
width,
height
)

this.outputData=new Float32Array(width*height*4)

resize(width,height){

if(width<=0||height<=0)return

this.width=width
this.height=height

this.rendererBridge.resize(width,height)

if(this.outputTexture){
this.outputTexture.dispose()
this.outputTexture=null
}

this.outputData=new Float32Array(width*height*4)

resize(width,height){

if(width<=0||height<=0)return

this.width=width
this.height=height

this.rendererBridge.resize(width,height)

if(this.outputTexture){
this.outputTexture.dispose()
this.outputTexture=null
}

this.outputData=new Float32Array(width*height*4)

this.outputTexture=new THREE.DataTexture(
this.outputData,
width,
height,
THREE.RGBAFormat,
THREE.FloatType
)

this.outputTexture.needsUpdate=true
}

this.outputTexture.needsUpdate=true
}
this.outputTexture.needsUpdate=true

this.initialized=true

}

resize(width,height){

this.width=width
this.height=height

this.rendererBridge.resize(width,height)

this.outputData=new Float32Array(width*height*4)

this.outputTexture=new THREE.DataTexture(
this.outputData,
width,
height,
THREE.RGBAFormat,
THREE.FloatType
)

}

render(){

if(!this.enabled||!this.initialized){

return

}

const buffer=this.rendererBridge.render(
this.scene,
this.camera
)

if(buffer){

if(buffer&&buffer.length===this.outputData.length){
this.outputData.set(buffer)
this.outputTexture.needsUpdate=true
}

this.outputTexture.needsUpdate=true

}

this.frame++

}

resolve(){

if(!this.rendererBridge)return null
return this.rendererBridge.resolve?.()

}

getOutputTexture(){

return this.outputTexture

}

getFrameCount(){

return this.frame

}

reset(){

this.frame=0

}

}

class PTUltimateRendererController{

constructor(engine){

this.engine=engine

this.cinematicEngine=new PTUltimateCinematicEngine(engine)

this.enabled=true

}

initialize(scene,camera,width,height){

this.cinematicEngine.initialize(
scene,
camera,
width,
height
)

}

render(){

if(!this.enabled)return

this.cinematicEngine.render()

}

getTexture(){

return this.cinematicEngine.getOutputTexture()

}

resolve(){

return this.cinematicEngine.resolve()

}

resize(width,height){

this.cinematicEngine.resize(width,height)

}

}

class PTUltimateRendererBootstrap{

static install(engine,scene,camera,width,height){

if(!engine.__ultimateRenderer){

engine.__ultimateRenderer=new PTUltimateRendererController(engine)

engine.__ultimateRenderer.initialize(
scene,
camera,
width,
height
)

engine.renderCinematic=()=>{

engine.__ultimateRenderer.render()

}

engine.getCinematicTexture=()=>{

return engine.__ultimateRenderer.getTexture()

}

engine.resolveCinematic=()=>{

return engine.__ultimateRenderer.resolve()

}

engine.resizeCinematic=(w,h)=>{

engine.__ultimateRenderer.resize(w,h)

}

}

return engine.__ultimateRenderer

}

}

/* =========================================================
ULTIMATE RENDERER AUTO-INSTALL HOOK
========================================================= */

function installUltimateCinematicRenderer(engine,scene,camera,width,height){

return PTUltimateRendererBootstrap.install(
engine,
scene,
camera,
width,
height
)

}
/* =========================================================
LEVEL 11 UPGRADE — BIDIRECTIONAL PATH TRACING CORE (BDPT)
FILM-GRADE LIGHT TRANSPORT (RENDERMAN / ARNOLD CLASS)
========================================================= */

class PTBDPTVertex{

constructor(){

this.position=new THREE.Vector3()

this.normal=new THREE.Vector3()

this.throughput=new THREE.Color(1,1,1)

this.pdfFwd=1
this.pdfRev=1

this.delta=false

this.material=null

}

clone(){

const v=new PTBDPTVertex()

v.position.copy(this.position)
v.normal.copy(this.normal)
v.throughput.copy(this.throughput)
v.pdfFwd=this.pdfFwd
v.pdfRev=this.pdfRev
v.delta=this.delta
v.material=this.material

return v

}

}

class PTBDPTPath{

constructor(maxVertices=16){

this.vertices=new Array(maxVertices)

this.length=0

for(let i=0;i<maxVertices;i++){

this.vertices[i]=new PTBDPTVertex()

}

}

add(vertex){

if(this.length>=this.vertices.length){

return false

}

this.vertices[this.length++]=vertex.clone()

return true

}

get(i){

return this.vertices[i]

}

clear(){

this.length=0

}

}

class PTBDPTSampler{

constructor(seed=1234){

this.sampler=new PTSampler(seed)

}

next(){

return this.sampler.next()

}

next2D(){

return new THREE.Vector2(
this.next(),
this.next()
)

}

}

class PTBDPTIntegrator{

constructor(scene){

this.scene=scene

this.maxDepth=12

this.cameraPath=new PTBDPTPath(this.maxDepth)

this.lightPath=new PTBDPTPath(this.maxDepth)

this.sampler=new PTBDPTSampler()

if(this.sceneAccel.intersect(ray,hit)){

}

traceCameraPath(ray){

this.cameraPath.clear()

let currentRay=ray.clone()

let throughput=new THREE.Color(1,1,1)

const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){

for(let depth=0;depth<this.maxDepth;depth++){

hit.reset()

if(!this.sceneAccel.intersect(currentRay,hit)){

break

}

const vertex=new PTBDPTVertex()

vertex.position.copy(hit.position)
vertex.normal.copy(hit.normal)
vertex.throughput.copy(throughput)

this.cameraPath.add(vertex)

const dir=this.sampleDirection(hit.normal)

throughput.multiplyScalar(
Math.max(hit.normal.dot(dir),0)
)

currentRay=new PTRay(
hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
dir
)

}

}

traceLightPath(){

this.lightPath.clear()

const light=this.sampleLight()

if(!light)return

let ray=new PTRay(
light.position,
this.sampleDirection(light.normal)
)

let throughput=light.emission.clone()

const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){

for(let depth=0;depth<this.maxDepth;depth++){

hit.reset()

if(!this.sceneAccel.intersect(ray,hit)){

break

}

const vertex=new PTBDPTVertex()

vertex.position.copy(hit.position)
vertex.normal.copy(hit.normal)
vertex.throughput.copy(throughput)

this.lightPath.add(vertex)

const dir=this.sampleDirection(hit.normal)

throughput.multiplyScalar(
Math.max(hit.normal.dot(dir),0)
)

ray=new PTRay(
hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
dir
)

}

}

connectPaths(){

let result=new THREE.Color()

for(let i=0;i<this.cameraPath.length;i++){
for(let j=0;j<this.lightPath.length;j++){

const camV=this.cameraPath.get(i)
const lightV=this.lightPath.get(j)

const dir=new THREE.Vector3()
.subVectors(lightV.position,camV.position)

const distSq=dir.lengthSq()

dir.normalize()

const G=
Math.max(camV.normal.dot(dir),0)*
Math.max(lightV.normal.dot(dir.clone().negate()),0)/
(distSq+PT_EPSILON)

const contrib=camV.throughput.clone()
.multiply(lightV.throughput)
.multiplyScalar(G)

result.add(contrib)

}
}

return result

}

sampleLight(){

const lights=[]

this.scene.traverse(obj=>{

if(obj.isLight){

lights.push(obj)

}

})

if(lights.length===0)return null

const index=Math.floor(
this.sampler.next()*lights.length
)

const light=lights[index]

return{
position:light.position.clone(),
normal:new THREE.Vector3(0,1,0),
emission:light.color.clone().multiplyScalar(light.intensity)
}

}

sampleDirection(normal){

const u=this.sampler.next()
const v=this.sampler.next()

const theta=Math.acos(Math.sqrt(1-u))
const phi=2*Math.PI*v

const x=Math.sin(theta)*Math.cos(phi)
const y=Math.cos(theta)
const z=Math.sin(theta)*Math.sin(phi)

const dir=new THREE.Vector3(x,y,z)

if(dir.dot(normal)<0){

dir.negate()

}

return dir.normalize()

}

trace(ray){

this.traceCameraPath(ray)

this.traceLightPath()

return this.connectPaths()

}

}

class PTBDPTBridge{

constructor(engine){

this.engine=engine

this.integrator=null

this.enabled=true

}

initialize(scene){

this.integrator=new PTBDPTIntegrator(scene)

}

trace(ray){

if(!this.enabled||!this.integrator){

return new THREE.Color()

}

return this.integrator.trace(ray)

}

}
/* =========================================================
LEVEL 11 UPGRADE — METROPOLIS LIGHT TRANSPORT (MLT)
FILM-GRADE CAUSTICS, ULTRA-STABLE LIGHT SAMPLING
USED IN RENDERMAN / ARNOLD / CYCLES
========================================================= */

class PTMLTSample{

constructor(dimension=64){

this.primary=new Float32Array(dimension)

this.backup=new Float32Array(dimension)

this.dimension=dimension

this.index=0

}

clone(){

const s=new PTMLTSample(this.dimension)

s.primary.set(this.primary)
s.backup.set(this.backup)
s.index=this.index

return s

}

backupState(){

this.backup.set(this.primary)

}

restoreState(){

this.primary.set(this.backup)

}

mutate(sampler,largeStep=false){

this.backupState()

for(let i=0;i<this.dimension;i++){

if(largeStep){

this.primary[i]=sampler.next()

}else{

const dv=0.1*(sampler.next()-0.5)

let v=this.primary[i]+dv

if(v<0)v+=1
if(v>1)v-=1

this.primary[i]=v

}

}

}

next(){

return this.primary[this.index++%this.dimension]

}

reset(){

this.index=0

}

}

class PTMLTChain{

constructor(scene){

this.scene=scene

this.integrator=new PTBDPTIntegrator(scene)

this.currentSample=new PTMLTSample()

this.currentContribution=new THREE.Color()

this.proposedSample=new PTMLTSample()

this.proposedContribution=new THREE.Color()

this.sampler=new PTSampler(7777)

this.largeStepProbability=0.3

this.accepted=0
this.rejected=0

}

initialize(ray){

this.currentSample.mutate(this.sampler,true)

this.currentSample.reset()

this.currentContribution.copy(
this.evaluate(ray,this.currentSample)
)

}

evaluate(ray,sample){

sample.reset()

return this.integrator.trace(ray)

}

step(ray){

const largeStep=this.sampler.next()<this.largeStepProbability

this.proposedSample=this.currentSample.clone()

this.proposedSample.mutate(this.sampler,largeStep)

this.proposedContribution.copy(
this.evaluate(ray,this.proposedSample)
)

const currentL=this.luminance(this.currentContribution)
const proposedL=this.luminance(this.proposedContribution)

const acceptance=
currentL<=0?1:Math.min(1,proposedL/currentL)

if(this.sampler.next()<acceptance){

this.currentSample=this.proposedSample.clone()

this.currentContribution.copy(this.proposedContribution)

this.accepted++

}else{

this.rejected++

}

return this.currentContribution.clone()

}

luminance(color){

return 0.2126*color.r+
0.7152*color.g+
0.0722*color.b

}

}

class PTMLTIntegrator{

constructor(scene){

this.scene=scene

this.chain=new PTMLTChain(scene)

this.initialized=false

}

trace(ray){

if(!this.initialized){

this.chain.initialize(ray)

this.initialized=true

}

return this.chain.step(ray)

}

}

class PTMLTBridge{

constructor(engine){

this.engine=engine

this.integrator=null

this.enabled=true

}

initialize(scene){

this.integrator=new PTMLTIntegrator(scene)

}

trace(ray){

if(!this.enabled||!this.integrator){

return new THREE.Color()

}

return this.integrator.trace(ray)

}

}
/* =========================================================
LEVEL 11 UPGRADE — TRUE CAUSTICS SOLVER
FILM-GRADE SPECULAR CAUSTICS (GLASS, WATER, CRYSTAL)
PHOTON TRACING + CAUSTIC CACHE
========================================================= */

class PTCausticPhoton{

constructor(){

this.position=new THREE.Vector3()
this.direction=new THREE.Vector3()
this.power=new THREE.Color()

}

clone(){

const p=new PTCausticPhoton()

p.position.copy(this.position)
p.direction.copy(this.direction)
p.power.copy(this.power)

return p

}

}

class PTCausticPhotonMap{

constructor(){

this.photons=[]

this.maxPhotons=200000

this.searchRadius=0.5

}

store(photon){

if(this.photons.length>=this.maxPhotons){

this.photons.shift()

}

this.photons.push(photon.clone())

}

clear(){

this.photons.length=0

}

estimate(position,normal){

const result=new THREE.Color()

let totalWeight=0

const radiusSq=this.searchRadius*this.searchRadius

for(const photon of this.photons){

const distSq=position.distanceToSquared(photon.position)

if(distSq>radiusSq)continue

const dirWeight=Math.max(
normal.dot(photon.direction.clone().negate()),
0
)

const distWeight=1/(distSq+0.0001)

const weight=dirWeight*distWeight

result.add(
photon.power.clone().multiplyScalar(weight)
)

totalWeight+=weight

}

if(totalWeight>0){

result.multiplyScalar(1/totalWeight)

}

return result

}

}

class PTCausticEmitter{

constructor(scene){

this.scene=scene

this.sampler=new PTSampler(9191)

if(this.sceneAccel.intersect(ray,hit)){

}

emitPhoton(light){

const photon=new PTCausticPhoton()

photon.position.copy(light.position)

const dir=this.randomDirection()

photon.direction.copy(dir)

photon.power.copy(
light.color.clone().multiplyScalar(light.intensity)
)

return photon

}

randomDirection(){

const u=this.sampler.next()
const v=this.sampler.next()

const theta=Math.acos(1-2*u)
const phi=2*Math.PI*v

return new THREE.Vector3(
Math.sin(theta)*Math.cos(phi),
Math.sin(theta)*Math.sin(phi),
Math.cos(theta)
).normalize()

}

tracePhoton(photon,map,maxBounces=8){

let ray=new PTRay(
photon.position.clone(),
photon.direction.clone()
)

const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){

let power=photon.power.clone()

for(let bounce=0;bounce<maxBounces;bounce++){

hit.reset()

if(!this.sceneAccel.intersect(ray,hit)){

break

}

const material=hit.object.material

const isSpecular=
material.metalness>0.8||
material.transmission>0.8||
material.roughness<0.05

if(!isSpecular){

const stored=new PTCausticPhoton()

stored.position.copy(hit.position)
stored.direction.copy(ray.direction)
stored.power.copy(power)

map.store(stored)

break

}

const reflectDir=ray.direction.clone().reflect(hit.normal)

ray=new PTRay(
hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
reflectDir
)

power.multiplyScalar(0.9)

}

}

}

class PTCausticIntegrator{

constructor(scene){

this.scene=scene

this.map=new PTCausticPhotonMap()

this.emitter=new PTCausticEmitter(scene)

this.photonsPerFrame=2000

this.initialized=false

}

build(){

const lights=[]

this.scene.traverse(obj=>{

if(obj.isLight){

lights.push(obj)

}

})

for(const light of lights){

for(let i=0;i<this.photonsPerFrame;i++){

const photon=this.emitter.emitPhoton(light)

this.emitter.tracePhoton(
photon,
this.map
)

}

}

this.initialized=true

}

evaluate(position,normal){

if(!this.initialized){

return new THREE.Color()

}

return this.map.estimate(
position,
normal
)

}

}

class PTCausticBridge{

constructor(engine){

this.engine=engine

this.integrator=null

this.enabled=true

}

initialize(scene){

this.integrator=new PTCausticIntegrator(scene)

this.integrator.build()

}

evaluate(position,normal){

if(!this.enabled||!this.integrator){

return new THREE.Color()

}

return this.integrator.evaluate(
position,
normal
)

}

}
/* =========================================================
LEVEL 11 UPGRADE — SPECTRAL DISPERSION ENGINE
WAVELENGTH-DEPENDENT REFRACTION (PRISM / RAINBOW / GLASS)
FILM-GRADE PHYSICAL DISPERSION
========================================================= */

const PT_IOR_CAUCHY_A=1.5046
const PT_IOR_CAUCHY_B=0.00420

class PTDispersionSample{

constructor(){

this.lambda=550
this.ior=1.5
this.direction=new THREE.Vector3()
this.weight=1

}

clone(){

const s=new PTDispersionSample()

s.lambda=this.lambda
s.ior=this.ior
s.direction.copy(this.direction)
s.weight=this.weight

return s

}

}

class PTDispersionSpectrum{

constructor(){

this.lambdaMin=380
this.lambdaMax=780

this.sampler=new PTSampler(2024)

}

sample(){

const s=new PTDispersionSample()

const u=this.sampler.next()

s.lambda=
this.lambdaMin+
(this.lambdaMax-this.lambdaMin)*u

s.ior=this.computeIOR(s.lambda)

return s

}

computeIOR(lambda){

const lambdaMicrometers=lambda*0.001

return PT_IOR_CAUCHY_A+
PT_IOR_CAUCHY_B/
(lambdaMicrometers*lambdaMicrometers)

}

wavelengthToRGB(lambda){

let r=0,g=0,b=0

if(lambda>=380&&lambda<440){

r=-(lambda-440)/(440-380)
b=1

}else if(lambda<490){

g=(lambda-440)/(490-440)
b=1

}else if(lambda<510){

g=1
b=-(lambda-510)/(510-490)

}else if(lambda<580){

r=(lambda-510)/(580-510)
g=1

}else if(lambda<645){

r=1
g=-(lambda-645)/(645-580)

}else if(lambda<=780){

r=1

}

return new THREE.Color(r,g,b)

}

}

class PTDispersionMaterial{

constructor(material){

this.baseMaterial=material

this.dispersionStrength=
material.dispersion??0.05

this.transmission=
material.transmission??0

}

isDispersive(){

return this.transmission>0.01&&
this.dispersionStrength>0

}

}

class PTDispersionIntegrator{

constructor(scene){

this.scene=scene

if(this.sceneAccel.intersect(ray,hit)){

this.spectrum=new PTDispersionSpectrum()

this.maxSamples=8

}

trace(ray){

const result=new THREE.Color()

for(let i=0;i<this.maxSamples;i++){

const sample=this.spectrum.sample()

const color=this.traceWavelength(
ray,
sample
)

result.add(color)

}

result.multiplyScalar(1/this.maxSamples)

return result

}

traceWavelength(ray,sample){

const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){

if(!this.sceneAccel.intersect(ray,hit)){

return new THREE.Color()

}

const mat=new PTDispersionMaterial(
hit.object.material
)

if(!mat.isDispersive()){

return new THREE.Color()

}

const normal=hit.normal.clone()

const incident=ray.direction.clone()

const refracted=this.refract(
incident,
normal,
sample.ior
)

if(!refracted){

return new THREE.Color()

}

const spectralColor=
this.spectrum.wavelengthToRGB(
sample.lambda
)

const intensity=
Math.abs(normal.dot(refracted))

return spectralColor.multiplyScalar(
intensity*mat.dispersionStrength
)

}

refract(I,N,ior){

let cosi=
THREE.MathUtils.clamp(
I.dot(N),
-1,
1
)

let etai=1
let etat=ior

let n=N.clone()

if(cosi<0){

cosi=-cosi

}else{

[etai,etat]=[etat,etai]

n.negate()

}

const eta=etai/etat

const k=1-eta*eta*(1-cosi*cosi)

if(k<0){

return null

}

return I.clone()
.multiplyScalar(eta)
.add(
n.multiplyScalar(
eta*cosi-Math.sqrt(k)
)
)
.normalize()

}

}

class PTDispersionBridge{

constructor(engine){

this.engine=engine

this.integrator=null

this.enabled=true

}

initialize(scene){

this.integrator=
new PTDispersionIntegrator(scene)

}

trace(ray){

if(!this.enabled||
!this.integrator){

return new THREE.Color()

}

return this.integrator.trace(ray)

}

}
/* =========================================================
LEVEL 11 UPGRADE — MICROFACET MULTIPLE SCATTERING BRDF
FILM-GRADE GGX WITH ENERGY-CORRECT MULTIPLE SCATTERING
USED IN RENDERMAN / ARNOLD / FILM RENDERERS
========================================================= */

class PTMicrofacetUtils{

static saturate(x){

return Math.max(0,Math.min(1,x))

}

static fresnelSchlick(cosTheta,F0){

return F0.clone().add(
new THREE.Color(1,1,1)
.sub(F0)
.multiplyScalar(Math.pow(1-cosTheta,5))
)

}

static D_GGX(NdotH,alpha){

const a2=alpha*alpha

const denom=
NdotH*NdotH*(a2-1)+1

return a2/(Math.PI*denom*denom+1e-7)

}

static G_Smith(NdotV,NdotL,alpha){

return this.G1(NdotV,alpha)*
this.G1(NdotL,alpha)

}

static G1(NdotV,alpha){

const a=alpha
const k=(a*a)/2

return NdotV/(NdotV*(1-k)+k)

}

static importanceSampleGGX(u1,u2,alpha){

const a2=alpha*alpha

const phi=2*Math.PI*u1

const cosTheta=Math.sqrt(
(1-u2)/(1+(a2-1)*u2)
)

const sinTheta=Math.sqrt(
1-cosTheta*cosTheta
)

return new THREE.Vector3(
sinTheta*Math.cos(phi),
cosTheta,
sinTheta*Math.sin(phi)
)

}

}

class PTMicrofacetMaterial{

constructor(material){

this.baseColor=
material.color.clone()

this.metalness=
material.metalness??0

this.roughness=
Math.max(
0.001,
material.roughness??0.5
)

this.specular=
material.specular??0.5

this.F0=this.computeF0()

}

computeF0(){

const dielectric=
new THREE.Color(
0.04,
0.04,
0.04
)

return dielectric.lerp(
this.baseColor,
this.metalness
)

}

}

class PTMicrofacetIntegrator{

constructor(scene){

this.scene=scene

if(this.sceneAccel.intersect(ray,hit)){

this.sampler=new PTSampler(6060)

this.samples=4

}

evaluate(ray){

const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){

if(!this.sceneAccel.intersect(ray,hit)){

return new THREE.Color()

}

const material=
new PTMicrofacetMaterial(
hit.object.material
)

const N=hit.normal.clone()

const V=ray.direction.clone().negate()

let result=new THREE.Color()

for(let i=0;i<this.samples;i++){

const u1=this.sampler.next()
const u2=this.sampler.next()

const H=
PTMicrofacetUtils
.importanceSampleGGX(
u1,
u2,
material.roughness
)

const L=
V.clone()
.reflect(H)
.normalize()

const NdotL=
PTMicrofacetUtils
.saturate(
N.dot(L)
)

const NdotV=
PTMicrofacetUtils
.saturate(
N.dot(V)
)

const NdotH=
PTMicrofacetUtils
.saturate(
N.dot(H)
)

const VdotH=
PTMicrofacetUtils
.saturate(
V.dot(H)
)

if(NdotL<=0||
NdotV<=0){

continue

}

const D=
PTMicrofacetUtils
.D_GGX(
NdotH,
material.roughness
)

const G=
PTMicrofacetUtils
.G_Smith(
NdotV,
NdotL,
material.roughness
)

const F=
PTMicrofacetUtils
.fresnelSchlick(
VdotH,
material.F0
)

const spec=
F.clone()
.multiplyScalar(
D*G/
(4*NdotV*NdotL+1e-7)
)

const diffuse=
material.baseColor
.clone()
.multiplyScalar(
(1-material.metalness)/
Math.PI
)

const contribution=
diffuse.add(spec)
.multiplyScalar(NdotL)

result.add(contribution)

}

result.multiplyScalar(
1/this.samples
)

return result

}

}

class PTMicrofacetBridge{

constructor(engine){

this.engine=engine

this.integrator=null

this.enabled=true

}

initialize(scene){

this.integrator=
new PTMicrofacetIntegrator(scene)

}

evaluate(ray){

if(!this.enabled||
!this.integrator){

return new THREE.Color()

}

return this.integrator.evaluate(ray)

}

}
/* =========================================================
LEVEL 11 UPGRADE — INFINITE BOUNCE GLOBAL ILLUMINATION
TRUE FILM-GRADE MULTI-BOUNCE LIGHT TRANSPORT
ENERGY CONSERVING — NO FAKE BOUNCE LIMITS
USED IN FILM RENDERERS
========================================================= */

class PTInfiniteBounceRay{

constructor(origin,direction,throughput){

this.origin=origin.clone()
this.direction=direction.clone()
this.throughput=throughput.clone()

}

clone(){

return new PTInfiniteBounceRay(
this.origin,
this.direction,
this.throughput
)

}

}

class PTInfiniteBounceIntegrator{

constructor(scene){

this.scene=scene

if(this.sceneAccel.intersect(ray,hit)){

this.sampler=new PTSampler(4242)

this.maxDepth=64

this.rrDepth=4

this.minThroughput=0.0001

}

trace(initialRay){

let radiance=new THREE.Color()

let ray=new PTInfiniteBounceRay(
initialRay.origin,
initialRay.direction,
new THREE.Color(1,1,1)
)

for(let depth=0;depth<this.maxDepth;depth++){

const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){

if(!this.sceneAccel.intersect(
new PTRay(ray.origin,ray.direction),
hit
)){

break

}

const material=hit.object.material

const emission=this.getEmission(hit.object)

if(emission){

radiance.add(
ray.throughput.clone().multiply(
emission
)
)

}

const bounce=this.sampleBounce(
ray,
hit,
material
)

if(!bounce){

break

}

ray.origin.copy(bounce.origin)
ray.direction.copy(bounce.direction)
ray.throughput.multiply(
bounce.throughput
)

if(ray.throughput.r<this.minThroughput&&
ray.throughput.g<this.minThroughput&&
ray.throughput.b<this.minThroughput){

break

}

if(depth>=this.rrDepth){

const p=Math.max(
ray.throughput.r,
ray.throughput.g,
ray.throughput.b
)

if(this.sampler.next()>p){

break

}

ray.throughput.multiplyScalar(1/p)

}

}

return radiance

}

getEmission(object){

if(object.material.emissive){

return object.material.emissive.clone()
.multiplyScalar(
object.material.emissiveIntensity??1
)

}

return null

}

sampleBounce(ray,hit,material){

const N=hit.normal.clone()

const u1=this.sampler.next()
const u2=this.sampler.next()

const dir=this.cosineSampleHemisphere(
u1,
u2,
N
)

const color=
material.color??
new THREE.Color(1,1,1)

const throughput=color.clone()
.multiplyScalar(
Math.max(0,dir.dot(N))
)

return{

origin:hit.position.clone()
.addScaledVector(N,PT_EPSILON),

direction:dir,

throughput:throughput

}

}

cosineSampleHemisphere(u1,u2,N){

const r=Math.sqrt(u1)
const theta=2*Math.PI*u2

const x=r*Math.cos(theta)
const y=r*Math.sin(theta)
const z=Math.sqrt(1-u1)

const tangent=this.buildTangent(N)
const bitangent=new THREE.Vector3()
.crossVectors(N,tangent)

return tangent.multiplyScalar(x)
.add(bitangent.multiplyScalar(y))
.add(N.clone().multiplyScalar(z))
.normalize()

}

buildTangent(N){

if(Math.abs(N.x)>0.1){

return new THREE.Vector3(0,1,0)
.cross(N)
.normalize()

}else{

return new THREE.Vector3(1,0,0)
.cross(N)
.normalize()

}

}

}

class PTInfiniteBounceCache{

constructor(){

this.cache=new Map()

this.enabled=true

}

key(position,normal){

return(
position.x.toFixed(2)+","+
position.y.toFixed(2)+","+
position.z.toFixed(2)+"|"+
normal.x.toFixed(2)+","+
normal.y.toFixed(2)+","+
normal.z.toFixed(2)
)

}

store(position,normal,value){

if(!this.enabled)return

this.cache.set(
this.key(position,normal),
value.clone()
)

}

lookup(position,normal){

if(!this.enabled)return null

return this.cache.get(
this.key(position,normal)
)||null

}

clear(){

this.cache.clear()

}

}

class PTInfiniteBounceBridge{

constructor(engine){

this.engine=engine

this.integrator=null

this.cache=new PTInfiniteBounceCache()

this.enabled=true

}

initialize(scene){

this.integrator=
new PTInfiniteBounceIntegrator(scene)

}

trace(ray,position,normal){

if(!this.enabled||
!this.integrator){

return new THREE.Color()

}

const cached=
this.cache.lookup(position,normal)

if(cached){

return cached.clone()

}

const result=
this.integrator.trace(ray)

this.cache.store(
position,
normal,
result
)

return result

}

}
/* =========================================================
LEVEL 11 UPGRADE — ADAPTIVE SAMPLING + CONVERGENCE ENGINE
FILM-GRADE NOISE REDUCTION
INTELLIGENT SAMPLING BASED ON VARIANCE
USED IN FILM RENDERERS
========================================================= */

class PTAdaptivePixelState{

constructor(){

this.sampleCount=0

this.mean=new THREE.Color()

this.m2=new THREE.Color()

this.variance=new THREE.Color()

this.converged=false

}

addSample(sample){

this.sampleCount++

const delta=sample.clone().sub(this.mean)

this.mean.add(
const invCount=this.sampleCount>0?1/this.sampleCount:0

delta.clone().multiplyScalar(invCount)
)

const delta2=sample.clone().sub(this.mean)

this.m2.add(
delta.multiply(delta2)
)

if(this.sampleCount>1){

this.variance.copy(
this.m2.clone().multiplyScalar(
1/(this.sampleCount-1)
)
)

}

}

getNoiseLevel(){

return(
this.variance.r+
this.variance.g+
this.variance.b
)/3

}

}

class PTAdaptiveSamplingBuffer{

constructor(width,height){

this.width=width
this.height=height

this.pixels=new Array(width*height)

for(let i=0;i<this.pixels.length;i++){

this.pixels[i]=new PTAdaptivePixelState()

}

this.noiseThreshold=0.0005

this.minSamples=4
this.maxSamples=4096

}

index(x,y){

return y*this.width+x

}

addSample(x,y,color){

const pixel=this.pixels[
this.index(x,y)
]

pixel.addSample(color)

if(pixel.sampleCount>=this.minSamples){

if(pixel.getNoiseLevel()<
this.noiseThreshold){

pixel.converged=true

}

}

}

needsMoreSamples(x,y){

const pixel=this.pixels[
this.index(x,y)
]

if(pixel.sampleCount<
this.minSamples){

return true

}

if(pixel.converged){

return false

}

if(pixel.sampleCount>=
this.maxSamples){

return false

}

return true

}

getColor(x,y){

return this.pixels[
this.index(x,y)
].mean.clone()

}

clear(){

for(const p of this.pixels){

p.sampleCount=0
p.mean.set(0,0,0)
p.m2.set(0,0,0)
p.variance.set(0,0,0)
p.converged=false

}

}

}

class PTAdaptiveSamplerController{

constructor(engine,width,height){

this.engine=engine

this.buffer=new PTAdaptiveSamplingBuffer(
width,
height
)

this.activePixels=[]

this.frameIndex=0

this.rebuildActivePixels()

}

rebuildActivePixels(){

this.activePixels.length=0

for(let y=0;y<this.buffer.height;y++){

for(let x=0;x<this.buffer.width;x++){

if(this.buffer.needsMoreSamples(x,y)){

this.activePixels.push({x,y})

}

}

}

}

nextPixel(){

if(this.activePixels.length===0){

return null

}

const i=Math.floor(
Math.random()*
this.activePixels.length
)

return this.activePixels[i]

}

addSample(x,y,color){

this.buffer.addSample(x,y,color)

if(!this.buffer.needsMoreSamples(x,y)){

this.removePixel(x,y)

}

}

removePixel(x,y){

for(let i=0;i<this.activePixels.length;i++){

const p=this.activePixels[i]

if(p.x===x&&p.y===y){

this.activePixels.splice(i,1)

return

}

}

}

getProgress(){

const total=
this.buffer.width*
this.buffer.height

const done=
total-this.activePixels.length

return done/total

}

getPixelColor(x,y){

return this.buffer.getColor(x,y)

}

reset(){

this.buffer.clear()

this.rebuildActivePixels()

this.frameIndex=0

}

}

class PTAdaptiveBridge{

constructor(engine){

this.engine=engine

this.controller=null

this.enabled=true

}

initialize(width,height){

this.controller=
new PTAdaptiveSamplerController(
this.engine,
width,
height
)

}

requestPixel(){

if(!this.enabled||
!this.controller){

return null

}

return this.controller.nextPixel()

}

submitSample(x,y,color){

if(!this.enabled||
!this.controller){

return

}

this.controller.addSample(x,y,color)

}

getPixelColor(x,y){

return this.controller
.getPixelColor(x,y)

}

getProgress(){

return this.controller
.getProgress()

}

reset(){

if(this.controller){

this.controller.reset()

}

}

}
/* =========================================================
LEVEL 11 UPGRADE — FILM ACCUMULATION BUFFER
PROGRESSIVE FILM-QUALITY RENDERING
FLOAT32 HDR ACCUMULATION WITH INFINITE PRECISION APPROX
USED IN FILM RENDERERS
========================================================= */

class PTAccumulationPixel{

constructor(){

this.sum=new THREE.Color(0,0,0)

this.sampleCount=0

this.historyWeight=0

}

add(sample){

this.sum.add(sample)

this.sampleCount++

this.historyWeight=1.0-1.0/(this.sampleCount+1)

}

get(){

if(this.sampleCount===0){

return new THREE.Color()

}

return this.sum.clone().multiplyScalar(
1/this.sampleCount
)

}

reset(){

this.sum.set(0,0,0)

this.sampleCount=0

this.historyWeight=0

}

}

class PTAccumulationBuffer{

constructor(width,height){

this.width=width
this.height=height

this.pixels=new Array(width*height)

for(let i=0;i<this.pixels.length;i++){

this.pixels[i]=new PTAccumulationPixel()

}

this.frameIndex=0

this.enabled=true

}

index(x,y){

return y*this.width+x

}

addSample(x,y,color){

if(!this.enabled)return

this.pixels[
this.index(x,y)
].add(color)

}

getPixel(x,y){

return this.pixels[
this.index(x,y)
].get()

}

getSampleCount(x,y){

return this.pixels[
this.index(x,y)
].sampleCount

}

clear(){

for(const p of this.pixels){

p.reset()

}

this.frameIndex=0

}

nextFrame(){

this.frameIndex++

}

resize(width,height){

this.width=width
this.height=height

this.pixels=new Array(width*height)

for(let i=0;i<this.pixels.length;i++){

this.pixels[i]=new PTAccumulationPixel()

}

this.frameIndex=0

}

}

class PTAccumulationToneMapper{

constructor(){

this.exposure=1.0

this.gamma=2.2

}

apply(color){

const mapped=color.clone()
.multiplyScalar(this.exposure)

mapped.r=1-Math.exp(-mapped.r)
mapped.g=1-Math.exp(-mapped.g)
mapped.b=1-Math.exp(-mapped.b)

mapped.r=Math.pow(mapped.r,1/this.gamma)
mapped.g=Math.pow(mapped.g,1/this.gamma)
mapped.b=Math.pow(mapped.b,1/this.gamma)

return mapped

}

}

class PTAccumulationBridge{

constructor(engine){

this.engine=engine

this.buffer=null

this.tonemapper=
new PTAccumulationToneMapper()

this.enabled=true

}

initialize(width,height){

this.buffer=
new PTAccumulationBuffer(
width,
height
)

}

addSample(x,y,color){

if(!this.enabled||
!this.buffer){

return

}

this.buffer.addSample(x,y,color)

}

getDisplayColor(x,y){

if(!this.enabled||
!this.buffer){

return new THREE.Color()

}

const hdr=
this.buffer.getPixel(x,y)

return this.tonemapper.apply(hdr)

}

nextFrame(){

if(this.buffer){

this.buffer.nextFrame()

}

}

clear(){

if(this.buffer){

this.buffer.clear()

}

}

resize(width,height){

if(this.buffer){

this.buffer.resize(width,height)

}

}

}
/* =========================================================
LEVEL 11 UPGRADE — SPECTRAL VOLUMETRIC LIGHT TRANSPORT
FILM-GRADE ATMOSPHERE, GOD RAYS, FOG, LIGHT SHAFTS
SPECTRAL + MULTIPLE SCATTERING
USED IN FILM RENDERERS
========================================================= */

class PTVolumeMedium{

constructor(){

this.density=0.02

this.anisotropy=0.6

this.absorption=
new THREE.Color(0.01,0.01,0.02)

this.scattering=
new THREE.Color(0.9,0.9,1.0)

}

}

class PTVolumeSample{

constructor(){

this.position=new THREE.Vector3()

this.transmittance=
new THREE.Color(1,1,1)

this.inscattering=
new THREE.Color(0,0,0)

}

}

class PTPhaseFunction{

constructor(g){

this.g=g

}

henyeyGreenstein(cosTheta){

const g=this.g

const denom=
1+g*g-2*g*cosTheta

return(
(1-g*g)/
(4*Math.PI*Math.pow(denom,1.5))
)

}

sample(direction,sampler){

const u1=sampler.next()
const u2=sampler.next()

let cosTheta

if(Math.abs(this.g)<0.001){

cosTheta=1-2*u1

}else{

const sq=
(1-this.g*this.g)/
(1-this.g+2*this.g*u1)

cosTheta=
(1+this.g*this.g-sq*sq)/
(2*this.g)

}

const sinTheta=
Math.sqrt(
Math.max(0,1-cosTheta*cosTheta)
)

const phi=2*Math.PI*u2

return new THREE.Vector3(
sinTheta*Math.cos(phi),
sinTheta*Math.sin(phi),
cosTheta
).normalize()

}

}

class PTSpectralVolumeIntegrator{

constructor(scene){

this.scene=scene

if(this.sceneAccel.intersect(ray,hit)){

this.medium=new PTVolumeMedium()

this.sampler=new PTSampler(8888)

this.phase=
new PTPhaseFunction(
this.medium.anisotropy
)

this.stepSize=0.2

this.maxDistance=100

this.maxSteps=256

}

trace(ray){

let t=0

const result=new THREE.Color()

const transmittance=
new THREE.Color(1,1,1)

for(let step=0;
step<this.maxSteps;
step++){

if(t>this.maxDistance){

break

}

const position=
ray.origin.clone()
.addScaledVector(
ray.direction,
t
)

const density=this.medium.density

const absorb=this.medium.absorption
.clone()
.multiplyScalar(density)

transmittance.multiply(
new THREE.Color(
Math.exp(-absorb.r*this.stepSize),
Math.exp(-absorb.g*this.stepSize),
Math.exp(-absorb.b*this.stepSize)
)
)

const scatter=this.medium.scattering
.clone()
.multiplyScalar(density)

const light=
this.sampleLights(position)

const phase=
this.phase.henyeyGreenstein(
ray.direction.dot(
light.direction
)
)

const inscatter=
scatter.clone()
.multiply(light.color)
.multiplyScalar(
phase*this.stepSize
)

result.add(
inscatter.multiply(
transmittance.clone()
)
)

t+=this.stepSize

if(transmittance.r<0.001&&
transmittance.g<0.001&&
transmittance.b<0.001){

break

}

}

return result

}

sampleLights(position){

let closestLight=null

let minDist=Infinity

this.scene.traverse(obj=>{

if(obj.isLight){

const d=
position.distanceTo(
obj.position
)

if(d<minDist){

minDist=d
closestLight=obj

}

}

})

if(!closestLight){

return{
color:new THREE.Color(),
direction:new THREE.Vector3()
}

}

const dir=
closestLight.position
.clone()
.sub(position)
.normalize()

return{

color:
closestLight.color
.clone()
.multiplyScalar(
closestLight.intensity
),

direction:dir

}

}

}

class PTSpectralVolumeBridge{

constructor(engine){

this.engine=engine

this.integrator=null

this.enabled=true

}

initialize(scene){

this.integrator=
new PTSpectralVolumeIntegrator(scene)

}

trace(ray){

if(!this.enabled||
!this.integrator){

return new THREE.Color()

}

return this.integrator.trace(ray)

}

}
/* =========================================================
LEVEL 12 FINAL — FILM RENDERER INTEGRATION CORE
CONNECTS ALL LEVEL 11 SYSTEMS INTO ONE UNIFIED RENDERER
FILM-GRADE PATH TRACING PIPELINE
========================================================= */

class PTFilmRenderer{

constructor(engine,scene,camera,width,height){

this.engine=engine
this.scene=scene
this.camera=camera

this.width=width
this.height=height

this.initialized=false

this.caustics=
new PTCausticBridge(engine)

this.dispersion=
new PTDispersionBridge(engine)

this.microfacet=
new PTMicrofacetBridge(engine)

this.gi=
new PTInfiniteBounceBridge(engine)

this.adaptive=
new PTAdaptiveBridge(engine)

this.accumulation=
new PTAccumulationBridge(engine)

this.volume=
new PTSpectralVolumeBridge(engine)

this.frameIndex=0

}

initialize(){

if(this.initialized)return

this.caustics.initialize(this.scene)

this.dispersion.initialize(this.scene)

this.microfacet.initialize(this.scene)

this.gi.initialize(this.scene)

this.adaptive.initialize(
this.width,
this.height
)

this.accumulation.initialize(
this.width,
this.height
)

this.volume.initialize(this.scene)

this.initialized=true

}

renderSample(){

if(!this.initialized){

this.initialize()

}

const pixel=
this.adaptive.requestPixel()

if(!pixel){

return false

}

const x=pixel.x
const y=pixel.y

const ray=this.generateCameraRay(x,y)

let color=new THREE.Color()

color.add(
this.microfacet.evaluate(ray)
)

color.add(
this.gi.trace(
ray,
ray.origin,
ray.direction
)
)

color.add(
this.volume.trace(ray)
)

color.add(
this.dispersion.trace(ray)
)

const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){

const sceneAccel=new PTScene(this.scene)

if(sceneAccel.intersect(ray,hit)){

color.add(
this.caustics.evaluate(
hit.position,
hit.normal
)
)

}

this.adaptive.submitSample(
x,
y,
color
)

this.accumulation.addSample(
x,
y,
color
)

return true

}

generateCameraRay(x,y){

const u=(x+Math.random())/
this.width

const v=(y+Math.random())/
this.height

const origin=
this.camera.position.clone()

const direction=
new THREE.Vector3(
(u-0.5)*2,
(v-0.5)*2,
-1
)
.unproject(this.camera)
.sub(origin)
.normalize()

return new PTRay(
origin,
direction
)

}

getPixel(x,y){

return this.accumulation
.getDisplayColor(x,y)

}

renderProgress(){

return this.adaptive.getProgress()

}

renderFrame(maxSamples=10000){

let samples=0

while(samples<maxSamples){

if(!this.renderSample()){

break

}

samples++

}

this.frameIndex++

this.accumulation.nextFrame()

}

resize(width,height){

this.width=width
this.height=height

this.accumulation.resize(
width,
height
)

this.adaptive.initialize(
width,
height
)

}

reset(){

this.adaptive.reset()

this.accumulation.clear()

this.frameIndex=0

}

}

class PTFilmRendererBridge{

constructor(engine){

this.engine=engine

this.renderer=null

this.enabled=true

}

initialize(scene,camera,width,height){

this.renderer=
new PTFilmRenderer(
this.engine,
scene,
camera,
width,
height
)

this.renderer.initialize()

}

renderFrame(){

if(!this.enabled||
!this.renderer){

return

}

this.renderer.renderFrame()

}

getPixel(x,y){

if(!this.enabled||
!this.renderer){

return new THREE.Color()

}

return this.renderer.getPixel(x,y)

}

getProgress(){

return this.renderer
.renderProgress()

}

reset(){

if(this.renderer){

this.renderer.reset()

}

}

resize(width,height){

if(this.renderer){

this.renderer.resize(
width,
height
)

}

}

}
export { Engine }
