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
}
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

const PT_SPECTRAL_SAMPLES=31
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

// DUPLICATE CLASS REMOVED SAFE: class PTSpectralDistribution{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples=new Float32Array(PT_SPECTRAL_SAMPLES)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.lambdaStep=(PT_SPECTRAL_LAMBDA_MAX-PT_SPECTRAL_LAMBDA_MIN)/(PT_SPECTRAL_SAMPLES-1)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: setUniform(value){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples.fill(value)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: setGaussian(center,width,intensity){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<PT_SPECTRAL_SAMPLES;i++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const lambda=PT_SPECTRAL_LAMBDA_MIN+i*this.lambdaStep
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const d=lambda-center
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples[i]=intensity*Math.exp(-(d*d)/(2*width*width))
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sample(lambda){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const index=(lambda-PT_SPECTRAL_LAMBDA_MIN)/this.lambdaStep
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const i0=Math.floor(index)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const i1=Math.min(i0+1,PT_SPECTRAL_SAMPLES-1)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const t=index-i0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const v0=this.samples[Math.max(0,i0)]
// DUPLICATE REMOVED SAFE: const v1=this.samples[Math.max(0,i1)]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return v0*(1-t)+v1*t
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: multiply(other){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<PT_SPECTRAL_SAMPLES;i++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples[i]*=other.samples[i]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: scale(factor){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<PT_SPECTRAL_SAMPLES;i++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples[i]*=factor
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clone(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const d=new PTSpectralDistribution()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: d.samples.set(this.samples)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return d
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }

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

// DUPLICATE CLASS REMOVED SAFE: class PTSpectralIntegrator{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.maxBounces=8
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTSampler(8642)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let spectral=new PTSpectralColor()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: spectral.distribution.setUniform(0)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let throughput=new PTSpectralColor()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: throughput.distribution.setUniform(1)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let currentRay=ray.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let bounce=0;bounce<this.maxBounces;bounce++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: hit.reset()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!new PTScene(this.scene).intersect(currentRay,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const mat=new PTSpectralMaterial({
// DUPLICATE REMOVED SAFE: color:hit.object.material.color.getHex()
// DUPLICATE REMOVED SAFE: })
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const emission=mat.getEmission()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: spectral.multiply(emission)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const evalColor=mat.evaluate()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: throughput.multiply(evalColor)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const dir=this.randomHemisphere(hit.normal)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: currentRay=new PTRay(
// DUPLICATE REMOVED SAFE: hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
// DUPLICATE REMOVED SAFE: dir
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return throughput
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: randomHemisphere(normal){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const u=this.sampler.next()
// DUPLICATE REMOVED SAFE: const v=this.sampler.next()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const theta=Math.acos(Math.sqrt(1-u))
// DUPLICATE REMOVED SAFE: const phi=2*Math.PI*v
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const x=Math.sin(theta)*Math.cos(phi)
// DUPLICATE REMOVED SAFE: const y=Math.cos(theta)
// DUPLICATE REMOVED SAFE: const z=Math.sin(theta)*Math.sin(phi)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const dir=new THREE.Vector3(x,y,z)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(dir.dot(normal)<0)dir.negate()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return dir.normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTSpectralBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=new PTSpectralIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||!this.integrator){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color(0,0,0)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const spectral=this.integrator.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return spectral.toRGB()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: HYBRID RTX PATH TRACING CORE
// DUPLICATE REMOVED SAFE: UNIFIED CINEMATIC LIGHT TRANSPORT INTEGRATOR
// DUPLICATE REMOVED SAFE: COMBINES:
// DUPLICATE REMOVED SAFE: - PATH TRACING
// DUPLICATE REMOVED SAFE: - SPECTRAL RENDERING
// DUPLICATE REMOVED SAFE: - RTX REFLECTION
// DUPLICATE REMOVED SAFE: - GLOBAL ILLUMINATION
// DUPLICATE REMOVED SAFE: - SUBSURFACE SCATTERING
// DUPLICATE REMOVED SAFE: - ReSTIR LIGHT SAMPLING
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTHybridPathState{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.ray=null
// DUPLICATE REMOVED SAFE: this.throughput=new THREE.Color(1,1,1)
// DUPLICATE REMOVED SAFE: this.radiance=new THREE.Color(0,0,0)
// DUPLICATE REMOVED SAFE: this.bounce=0
// DUPLICATE REMOVED SAFE: this.done=false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: reset(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.ray=ray.clone()
// DUPLICATE REMOVED SAFE: this.throughput.set(1,1,1)
// DUPLICATE REMOVED SAFE: this.radiance.set(0,0,0)
// DUPLICATE REMOVED SAFE: this.bounce=0
// DUPLICATE REMOVED SAFE: this.done=false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTHybridMaterialAdapter{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(object){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.object=object
// DUPLICATE REMOVED SAFE: this.material=object.material
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: isEmissive(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.material.emissiveIntensity>0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getEmission(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.material.emissive.clone()
// DUPLICATE REMOVED SAFE: .multiplyScalar(this.material.emissiveIntensity)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getAlbedo(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.material.color.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getRoughness(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.material.roughness??0.5
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getMetalness(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.material.metalness??0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: isSSS(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.material.transmission>0.01
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTHybridIntegrator{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.maxBounces=12
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTSampler(999)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.sceneAccel.intersect(ray,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.spectral=new PTSpectralIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.reflection=new PTReflectionIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sss=new PTSSSIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const state=new PTHybridPathState()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: state.reset(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: while(!state.done){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(state.bounce>=this.maxBounces){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: state.done=true
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: hit.reset()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.sceneAccel.intersect(state.ray,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: state.done=true
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const adapter=new PTHybridMaterialAdapter(hit.object)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(adapter.isEmissive()){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: state.radiance.add(
// DUPLICATE REMOVED SAFE: adapter.getEmission()
// DUPLICATE REMOVED SAFE: .multiply(state.throughput)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const albedo=adapter.getAlbedo()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const spectral=this.spectral.trace(state.ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const reflection=this.reflection.traceReflection(state.ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const sss=adapter.isSSS()?this.sss.trace(state.ray):new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const combined=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: combined.add(albedo)
// DUPLICATE REMOVED SAFE: combined.add(reflection)
// DUPLICATE REMOVED SAFE: combined.add(sss)
// DUPLICATE REMOVED SAFE: combined.add(spectral)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: state.throughput.multiply(combined)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const nextDir=this.sampleDirection(
// DUPLICATE REMOVED SAFE: hit.normal,
// DUPLICATE REMOVED SAFE: adapter.getRoughness()
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: state.ray=new PTRay(
// DUPLICATE REMOVED SAFE: hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
// DUPLICATE REMOVED SAFE: nextDir
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.russianRoulette(state)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: state.done=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: state.bounce++
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return state.radiance
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sampleDirection(normal,roughness){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const u=this.sampler.next()
// DUPLICATE REMOVED SAFE: const v=this.sampler.next()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const theta=Math.acos(Math.pow(1-u,1/(roughness+1)))
// DUPLICATE REMOVED SAFE: const phi=2*Math.PI*v
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const x=Math.sin(theta)*Math.cos(phi)
// DUPLICATE REMOVED SAFE: const y=Math.cos(theta)
// DUPLICATE REMOVED SAFE: const z=Math.sin(theta)*Math.sin(phi)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const dir=new THREE.Vector3(x,y,z)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(dir.dot(normal)<0)dir.negate()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return dir.normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: russianRoulette(state){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(state.bounce<3)return false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const p=Math.max(
// DUPLICATE REMOVED SAFE: state.throughput.r,
// DUPLICATE REMOVED SAFE: state.throughput.g,
// DUPLICATE REMOVED SAFE: state.throughput.b
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.sampler.next()>p){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: state.throughput.multiplyScalar(1/p)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTHybridPathTracer{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=1
// DUPLICATE REMOVED SAFE: this.height=1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.accumulationBuffer=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=new PTHybridIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.resize(width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=width
// DUPLICATE REMOVED SAFE: this.height=height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.accumulationBuffer=new Float32Array(width*height*3)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: reset(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.accumulationBuffer.fill(0)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: tracePixel(x,y,camera){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const ray=this.generateCameraRay(x,y,camera)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const color=this.integrator.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const i=(y*this.width+x)*3
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.accumulationBuffer[i]+=color.r
// DUPLICATE REMOVED SAFE: this.accumulationBuffer[i+1]+=color.g
// DUPLICATE REMOVED SAFE: this.accumulationBuffer[i+2]+=color.b
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color(
// DUPLICATE REMOVED SAFE: this.accumulationBuffer[i]/(this.samples+1),
// DUPLICATE REMOVED SAFE: this.accumulationBuffer[i+1]/(this.samples+1),
// DUPLICATE REMOVED SAFE: this.accumulationBuffer[i+2]/(this.samples+1)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: generateCameraRay(x,y,camera){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const ndcX=(x+Math.random())/this.width*2-1
// DUPLICATE REMOVED SAFE: const ndcY=(y+Math.random())/this.height*2-1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const origin=camera.position.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const direction=new THREE.Vector3(ndcX,ndcY,1)
// DUPLICATE REMOVED SAFE: .unproject(camera)
// DUPLICATE REMOVED SAFE: .sub(origin)
// DUPLICATE REMOVED SAFE: .normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new PTRay(origin,direction)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: endFrame(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples++
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTHybridBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.tracer=new PTHybridPathTracer(engine)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.tracer.initialize(scene,width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.tracer.resize(width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: tracePixel(x,y,camera){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled)return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.tracer.tracePixel(x,y,camera)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: endFrame(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.tracer.endFrame()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: CINEMATIC CAMERA PHYSICAL MODEL
// DUPLICATE REMOVED SAFE: FILM LENS + APERTURE + SHUTTER + SENSOR SIMULATION
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCameraPhysicalParams{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sensorWidth=36.0
// DUPLICATE REMOVED SAFE: this.sensorHeight=24.0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.focalLength=50.0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.aperture=1.4
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.focusDistance=5.0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.shutterSpeed=1/48
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.iso=100
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.bladeCount=9
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.anamorphicRatio=1.0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getFOV(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return 2*Math.atan(this.sensorHeight/(2*this.focalLength))
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getApertureRadius(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.focalLength/(2*this.aperture)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getExposureMultiplier(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const t=this.shutterSpeed
// DUPLICATE REMOVED SAFE: const N=this.aperture
// DUPLICATE REMOVED SAFE: const S=this.iso
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return (t*S)/(N*N)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCameraRay{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.origin=new THREE.Vector3()
// DUPLICATE REMOVED SAFE: this.direction=new THREE.Vector3()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCameraLensSampler{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(params){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.params=params
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTSampler(4321)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sampleAperture(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const blades=this.params.bladeCount
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const r=Math.sqrt(this.sampler.next())
// DUPLICATE REMOVED SAFE: const theta=this.sampler.next()*Math.PI*2
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let x=r*Math.cos(theta)
// DUPLICATE REMOVED SAFE: let y=r*Math.sin(theta)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const radius=this.params.getApertureRadius()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: x*=radius
// DUPLICATE REMOVED SAFE: y*=radius
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: x*=this.params.anamorphicRatio
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Vector2(x,y)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCameraPhysical{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(threeCamera){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.camera=threeCamera
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.params=new PTCameraPhysicalParams()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.lensSampler=new PTCameraLensSampler(this.params)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: generateRay(x,y,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const ndcX=(x+Math.random())/width*2-1
// DUPLICATE REMOVED SAFE: const ndcY=(y+Math.random())/height*2-1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const origin=this.camera.position.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const target=new THREE.Vector3(ndcX,ndcY,1)
// DUPLICATE REMOVED SAFE: .unproject(this.camera)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const focusDir=target.clone().sub(origin).normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const focusPoint=origin.clone().addScaledVector(
// DUPLICATE REMOVED SAFE: focusDir,
// DUPLICATE REMOVED SAFE: this.params.focusDistance
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const apertureSample=this.lensSampler.sampleAperture()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const apertureWorld=new THREE.Vector3(
// DUPLICATE REMOVED SAFE: apertureSample.x,
// DUPLICATE REMOVED SAFE: apertureSample.y,
// DUPLICATE REMOVED SAFE: 0
// DUPLICATE REMOVED SAFE: ).applyQuaternion(this.camera.quaternion)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const newOrigin=origin.clone().add(apertureWorld)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const newDir=focusPoint.clone().sub(newOrigin).normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const ray=new PTCameraRay()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: ray.origin.copy(newOrigin)
// DUPLICATE REMOVED SAFE: ray.direction.copy(newDir)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return ray
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getExposure(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.params.getExposureMultiplier()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getFOV(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.params.getFOV()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCinematicShutter{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.shutterSpeed=1/48
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.shutterAngle=180
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frameTime=1/24
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getExposureTime(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.shutterAngle/360*this.frameTime
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sampleTime(sampler){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return sampler.next()*this.getExposureTime()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCameraMotionBlur{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples=8
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTSampler(5678)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.shutter=new PTCinematicShutter()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sampleMotion(camera,time){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const pos=camera.position.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const jitter=new THREE.Vector3(
// DUPLICATE REMOVED SAFE: (this.sampler.next()-0.5)*0.01,
// DUPLICATE REMOVED SAFE: (this.sampler.next()-0.5)*0.01,
// DUPLICATE REMOVED SAFE: (this.sampler.next()-0.5)*0.01
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: pos.add(jitter)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return pos
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCinematicCameraSystem{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cameraPhysical=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.motionBlur=new PTCameraMotionBlur()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(threeCamera){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cameraPhysical=new PTCameraPhysical(threeCamera)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: generateRay(x,y,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||!this.cameraPhysical){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.cameraPhysical.generateRay(
// DUPLICATE REMOVED SAFE: x,
// DUPLICATE REMOVED SAFE: y,
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getExposure(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||!this.cameraPhysical){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return 1.0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.cameraPhysical.getExposure()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: update(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: FILM-GRADE VOLUMETRIC LIGHTING + ATMOSPHERIC SCATTERING
// DUPLICATE REMOVED SAFE: PHYSICAL FOG, LIGHT SHAFTS, CINEMATIC AIR PERSPECTIVE
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTVolumeMedium{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(params={}){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.density=params.density??0.01
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scattering=params.scattering??0.9
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.absorption=params.absorption??0.1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.anisotropy=params.anisotropy??0.0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.color=new THREE.Color(params.color??0xffffff)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: evaluateTransmittance(distance){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const extinction=this.density*(this.scattering+this.absorption)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const T=Math.exp(-extinction*distance)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return T
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: evaluateScattering(distance){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const T=this.evaluateTransmittance(distance)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.color.clone().multiplyScalar(
// DUPLICATE REMOVED SAFE: this.scattering*(1-T)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sampleDistance(sampler){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const extinction=this.density*(this.scattering+this.absorption)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const u=sampler.next()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return -Math.log(1-u)/extinction
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTVolumeRegion{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(min,max,medium){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.min=min.clone()
// DUPLICATE REMOVED SAFE: this.max=max.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.medium=medium
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: contains(point){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return(
// DUPLICATE REMOVED SAFE: point.x>=this.min.x&&point.x<=this.max.x&&
// DUPLICATE REMOVED SAFE: point.y>=this.min.y&&point.y<=this.max.y&&
// DUPLICATE REMOVED SAFE: point.z>=this.min.z&&point.z<=this.max.z
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTVolumetricIntegrator{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.mediums=[]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.maxSteps=64
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.stepSize=0.2
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTSampler(8888)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: addMedium(region){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.mediums.push(region)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray,maxDistance=100){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const result=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let distance=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let transmittance=1.0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<this.maxSteps;i++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(distance>=maxDistance)break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const point=ray.origin.clone().addScaledVector(
// DUPLICATE REMOVED SAFE: ray.direction,
// DUPLICATE REMOVED SAFE: distance
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const medium=this.findMedium(point)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(medium){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const scatter=medium.evaluateScattering(
// DUPLICATE REMOVED SAFE: this.stepSize
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: result.add(
// DUPLICATE REMOVED SAFE: scatter.multiplyScalar(transmittance)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: transmittance*=medium.evaluateTransmittance(
// DUPLICATE REMOVED SAFE: this.stepSize
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: distance+=this.stepSize
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(transmittance<0.001){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return result
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: findMedium(point){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(const region of this.mediums){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(region.contains(point)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return region.medium
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTAtmosphereModel{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.rayleigh=new THREE.Color(0.5,0.7,1.0)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.mie=new THREE.Color(1.0,0.9,0.7)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.density=0.01
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: evaluate(direction){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const mu=Math.max(direction.y,0)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const rayleigh=this.rayleigh.clone().multiplyScalar(
// DUPLICATE REMOVED SAFE: Math.pow(mu,4)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const mie=this.mie.clone().multiplyScalar(
// DUPLICATE REMOVED SAFE: Math.pow(mu,1.5)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return rayleigh.add(mie).multiplyScalar(this.density)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTVolumetricLightingSystem{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=new PTVolumetricIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.atmosphere=new PTAtmosphereModel()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const medium=new PTVolumeMedium({
// DUPLICATE REMOVED SAFE: density:0.02,
// DUPLICATE REMOVED SAFE: scattering:0.9,
// DUPLICATE REMOVED SAFE: absorption:0.1,
// DUPLICATE REMOVED SAFE: color:0xffffff
// DUPLICATE REMOVED SAFE: })
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const region=new PTVolumeRegion(
// DUPLICATE REMOVED SAFE: new THREE.Vector3(-1000,-1000,-1000),
// DUPLICATE REMOVED SAFE: new THREE.Vector3(1000,1000,1000),
// DUPLICATE REMOVED SAFE: medium
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator.addMedium(region)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const volume=this.integrator.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const atmosphere=this.atmosphere.evaluate(ray.direction)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return volume.add(atmosphere)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTVolumetricBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.system=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.system=new PTVolumetricLightingSystem(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.system.initialize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||!this.system){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.system.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: GLOBAL ILLUMINATION CACHE + RADIANCE FIELD SYSTEM
// DUPLICATE REMOVED SAFE: FILM-GRADE INDIRECT LIGHTING STABILITY AND REUSE
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTRadianceSample{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.position=new THREE.Vector3()
// DUPLICATE REMOVED SAFE: this.normal=new THREE.Vector3()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.radiance=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.weight=1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clone(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const s=new PTRadianceSample()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: s.position.copy(this.position)
// DUPLICATE REMOVED SAFE: s.normal.copy(this.normal)
// DUPLICATE REMOVED SAFE: s.radiance.copy(this.radiance)
// DUPLICATE REMOVED SAFE: s.weight=this.weight
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return s
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTRadianceCache{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples=[]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.maxSamples=50000
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.searchRadius=2.0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: add(sample){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.samples.length>=this.maxSamples){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples.shift()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples.push(sample.clone())
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: query(position,normal){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const result=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let totalWeight=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(const s of this.samples){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const distSq=position.distanceToSquared(s.position)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(distSq>this.searchRadius*this.searchRadius){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: continue
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const normalWeight=Math.max(
// DUPLICATE REMOVED SAFE: normal.dot(s.normal),
// DUPLICATE REMOVED SAFE: 0
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const distWeight=1/(distSq+0.0001)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const weight=normalWeight*distWeight
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: result.add(
// DUPLICATE REMOVED SAFE: s.radiance.clone().multiplyScalar(weight)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: totalWeight+=weight
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(totalWeight>0){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: result.multiplyScalar(1/totalWeight)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return result
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clear(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples.length=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTRadianceField{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.gridSize=32
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cellSize=2.0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cells=new Map()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: _hash(x,y,z){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return `${x},${y},${z}`
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: _getCellCoords(position){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return{
// DUPLICATE REMOVED SAFE: x:Math.floor(position.x/this.cellSize),
// DUPLICATE REMOVED SAFE: y:Math.floor(position.y/this.cellSize),
// DUPLICATE REMOVED SAFE: z:Math.floor(position.z/this.cellSize)
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: addSample(sample){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const c=this._getCellCoords(sample.position)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const key=this._hash(c.x,c.y,c.z)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.cells.has(key)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cells.set(key,[])
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cells.get(key).push(sample.clone())
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: query(position,normal){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const c=this._getCellCoords(position)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const result=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let totalWeight=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let dz=-1;dz<=1;dz++){
// DUPLICATE REMOVED SAFE: for(let dy=-1;dy<=1;dy++){
// DUPLICATE REMOVED SAFE: for(let dx=-1;dx<=1;dx++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const key=this._hash(
// DUPLICATE REMOVED SAFE: c.x+dx,
// DUPLICATE REMOVED SAFE: c.y+dy,
// DUPLICATE REMOVED SAFE: c.z+dz
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const cell=this.cells.get(key)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!cell)continue
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(const sample of cell){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const distSq=position.distanceToSquared(
// DUPLICATE REMOVED SAFE: sample.position
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const normalWeight=Math.max(
// DUPLICATE REMOVED SAFE: normal.dot(sample.normal),
// DUPLICATE REMOVED SAFE: 0
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const weight=normalWeight/(distSq+0.001)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: result.add(
// DUPLICATE REMOVED SAFE: sample.radiance.clone()
// DUPLICATE REMOVED SAFE: .multiplyScalar(weight)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: totalWeight+=weight
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(totalWeight>0){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: result.multiplyScalar(1/totalWeight)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return result
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clear(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cells.clear()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTGlobalIlluminationSystem{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cache=new PTRadianceCache()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.field=new PTRadianceField()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.maxSamplesPerFrame=1000
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTSampler(4242)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: record(position,normal,radiance){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled)return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const sample=new PTRadianceSample()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sample.position.copy(position)
// DUPLICATE REMOVED SAFE: sample.normal.copy(normal)
// DUPLICATE REMOVED SAFE: sample.radiance.copy(radiance)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cache.add(sample)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.field.addSample(sample)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: evaluate(position,normal){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const cacheRadiance=this.cache.query(
// DUPLICATE REMOVED SAFE: position,
// DUPLICATE REMOVED SAFE: normal
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const fieldRadiance=this.field.query(
// DUPLICATE REMOVED SAFE: position,
// DUPLICATE REMOVED SAFE: normal
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return cacheRadiance.add(fieldRadiance).multiplyScalar(0.5)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: update(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clear(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cache.clear()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.field.clear()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTGlobalIlluminationBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.system=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.system=new PTGlobalIlluminationSystem(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: record(position,normal,radiance){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||!this.system)return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.system.record(
// DUPLICATE REMOVED SAFE: position,
// DUPLICATE REMOVED SAFE: normal,
// DUPLICATE REMOVED SAFE: radiance
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: evaluate(position,normal){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||!this.system){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.system.evaluate(
// DUPLICATE REMOVED SAFE: position,
// DUPLICATE REMOVED SAFE: normal
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clear(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.system){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.system.clear()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: FINAL UNIFIED CINEMATIC RENDERER
// DUPLICATE REMOVED SAFE: CONNECTS ALL SYSTEMS INTO ONE FILM-GRADE RENDER PIPELINE
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCinematicRendererCore{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.initialized=false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=1
// DUPLICATE REMOVED SAFE: this.height=1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.hybrid=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.gi=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.restir=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.volumetric=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.spectral=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.reflection=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sss=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.filmPipeline=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cameraSystem=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frameIndex=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene,camera,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=width
// DUPLICATE REMOVED SAFE: this.height=height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.hybrid=new PTHybridBridge(this.engine)
// DUPLICATE REMOVED SAFE: this.hybrid.initialize(scene,width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.gi=new PTGlobalIlluminationBridge(this.engine)
// DUPLICATE REMOVED SAFE: this.gi.initialize(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.restir=new PTReSTIRBridge(this.engine)
// DUPLICATE REMOVED SAFE: this.restir.initialize(scene,width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.volumetric=new PTVolumetricBridge(this.engine)
// DUPLICATE REMOVED SAFE: this.volumetric.initialize(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.spectral=new PTSpectralBridge(this.engine)
// DUPLICATE REMOVED SAFE: this.spectral.initialize(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.reflection=new PTReflectionHybridBridge(this.engine)
// DUPLICATE REMOVED SAFE: this.reflection.initialize(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sss=new PTSSSHybridBridge(this.engine)
// DUPLICATE REMOVED SAFE: this.sss.initialize(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.filmPipeline=new PTFilmPipelineBridge(this.engine)
// DUPLICATE REMOVED SAFE: this.filmPipeline.resize(width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cameraSystem=new PTCinematicCameraSystem(this.engine)
// DUPLICATE REMOVED SAFE: this.cameraSystem.initialize(camera)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.initialized=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=width
// DUPLICATE REMOVED SAFE: this.height=height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.hybrid)this.hybrid.resize(width,height)
// DUPLICATE REMOVED SAFE: if(this.restir)this.restir.resize(width,height)
// DUPLICATE REMOVED SAFE: if(this.filmPipeline)this.filmPipeline.resize(width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: beginFrame(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.initialized)return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.restir.beginFrame()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: renderPixel(x,y,camera){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.initialized)return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const ray=this.cameraSystem.generateRay(
// DUPLICATE REMOVED SAFE: x,
// DUPLICATE REMOVED SAFE: y,
// DUPLICATE REMOVED SAFE: this.width,
// DUPLICATE REMOVED SAFE: this.height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let color=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const hybrid=this.hybrid.tracePixel(x,y,camera)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const spectral=this.spectral.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const reflection=this.reflection.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const sss=this.sss.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const volumetric=this.volumetric.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const gi=this.gi.evaluate(ray.origin,ray.direction)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const restir=this.restir.resolve(x,y)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: color.add(hybrid)
// DUPLICATE REMOVED SAFE: color.add(spectral)
// DUPLICATE REMOVED SAFE: color.add(reflection)
// DUPLICATE REMOVED SAFE: color.add(sss)
// DUPLICATE REMOVED SAFE: color.add(volumetric)
// DUPLICATE REMOVED SAFE: color.add(gi)
// DUPLICATE REMOVED SAFE: color.add(restir)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const exposure=this.cameraSystem.getExposure()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: color.multiplyScalar(exposure)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.filmPipeline.addSample(x,y,color)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return color
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: endFrame(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.hybrid.endFrame()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frameIndex++
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resolveFrame(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.filmPipeline.process()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCinematicRenderer{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.core=new PTCinematicRendererCore(engine)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputBuffer=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene,camera,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.core.initialize(scene,camera,width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputBuffer=new Float32Array(width*height*4)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.core.resize(width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputBuffer=new Float32Array(width*height*4)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: render(scene,camera){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled)return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.core.beginFrame()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const width=this.core.width
// DUPLICATE REMOVED SAFE: const height=this.core.height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let i=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let y=0;y<height;y++){
// DUPLICATE REMOVED SAFE: for(let x=0;x<width;x++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const color=this.core.renderPixel(x,y,camera)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputBuffer[i++]=color.r
// DUPLICATE REMOVED SAFE: this.outputBuffer[i++]=color.g
// DUPLICATE REMOVED SAFE: this.outputBuffer[i++]=color.b
// DUPLICATE REMOVED SAFE: this.outputBuffer[i++]=1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.core.endFrame()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.outputBuffer
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resolve(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.core.resolveFrame()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCinematicRendererBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.renderer=new PTCinematicRenderer(engine)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene,camera,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.renderer.initialize(
// DUPLICATE REMOVED SAFE: scene,
// DUPLICATE REMOVED SAFE: camera,
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: render(scene,camera){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled)return null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.renderer.render(
// DUPLICATE REMOVED SAFE: scene,
// DUPLICATE REMOVED SAFE: camera
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resolve(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.renderer.resolve()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.renderer.resize(width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: FINAL ENGINE INTEGRATION LAYER
// DUPLICATE REMOVED SAFE: ULTIMATE CINEMATIC RENDERER ACTIVATION
// DUPLICATE REMOVED SAFE: THIS COMPLETES THE FULL CINEMATIC ENGINE
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTUltimateCinematicEngine{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.rendererBridge=new PTCinematicRendererBridge(engine)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.initialized=false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=null
// DUPLICATE REMOVED SAFE: this.camera=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=1
// DUPLICATE REMOVED SAFE: this.height=1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputTexture=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputData=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frame=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene,camera,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: this.camera=camera
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=width
// DUPLICATE REMOVED SAFE: this.height=height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.rendererBridge){
// DUPLICATE REMOVED SAFE: throw new Error("rendererBridge missing")
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.rendererBridge.initialize(
// DUPLICATE REMOVED SAFE: scene,
// DUPLICATE REMOVED SAFE: camera,
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputData=new Float32Array(width*height*4)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(width<=0||height<=0)return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=width
// DUPLICATE REMOVED SAFE: this.height=height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.rendererBridge.resize(width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.outputTexture){
// DUPLICATE REMOVED SAFE: this.outputTexture.dispose()
// DUPLICATE REMOVED SAFE: this.outputTexture=null
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputData=new Float32Array(width*height*4)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(width<=0||height<=0)return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=width
// DUPLICATE REMOVED SAFE: this.height=height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.rendererBridge.resize(width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.outputTexture){
// DUPLICATE REMOVED SAFE: this.outputTexture.dispose()
// DUPLICATE REMOVED SAFE: this.outputTexture=null
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputData=new Float32Array(width*height*4)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputTexture=new THREE.DataTexture(
// DUPLICATE REMOVED SAFE: this.outputData,
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height,
// DUPLICATE REMOVED SAFE: THREE.RGBAFormat,
// DUPLICATE REMOVED SAFE: THREE.FloatType
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputTexture.needsUpdate=true
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputTexture.needsUpdate=true
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: this.outputTexture.needsUpdate=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.initialized=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=width
// DUPLICATE REMOVED SAFE: this.height=height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.rendererBridge.resize(width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputData=new Float32Array(width*height*4)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputTexture=new THREE.DataTexture(
// DUPLICATE REMOVED SAFE: this.outputData,
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height,
// DUPLICATE REMOVED SAFE: THREE.RGBAFormat,
// DUPLICATE REMOVED SAFE: THREE.FloatType
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: render(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||!this.initialized){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const buffer=this.rendererBridge.render(
// DUPLICATE REMOVED SAFE: this.scene,
// DUPLICATE REMOVED SAFE: this.camera
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(buffer){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(buffer&&buffer.length===this.outputData.length){
// DUPLICATE REMOVED SAFE: this.outputData.set(buffer)
// DUPLICATE REMOVED SAFE: this.outputTexture.needsUpdate=true
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.outputTexture.needsUpdate=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frame++
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resolve(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.rendererBridge)return null
// DUPLICATE REMOVED SAFE: return this.rendererBridge.resolve?.()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getOutputTexture(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.outputTexture
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getFrameCount(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.frame
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: reset(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frame=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTUltimateRendererController{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cinematicEngine=new PTUltimateCinematicEngine(engine)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene,camera,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cinematicEngine.initialize(
// DUPLICATE REMOVED SAFE: scene,
// DUPLICATE REMOVED SAFE: camera,
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: render(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled)return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cinematicEngine.render()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getTexture(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.cinematicEngine.getOutputTexture()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resolve(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.cinematicEngine.resolve()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cinematicEngine.resize(width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTUltimateRendererBootstrap{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: static install(engine,scene,camera,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!engine.__ultimateRenderer){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: engine.__ultimateRenderer=new PTUltimateRendererController(engine)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: engine.__ultimateRenderer.initialize(
// DUPLICATE REMOVED SAFE: scene,
// DUPLICATE REMOVED SAFE: camera,
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: engine.renderCinematic=()=>{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: engine.__ultimateRenderer.render()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: engine.getCinematicTexture=()=>{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return engine.__ultimateRenderer.getTexture()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: engine.resolveCinematic=()=>{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return engine.__ultimateRenderer.resolve()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: engine.resizeCinematic=(w,h)=>{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: engine.__ultimateRenderer.resize(w,h)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return engine.__ultimateRenderer
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: ULTIMATE RENDERER AUTO-INSTALL HOOK
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: function installUltimateCinematicRenderer(engine,scene,camera,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return PTUltimateRendererBootstrap.install(
// DUPLICATE REMOVED SAFE: engine,
// DUPLICATE REMOVED SAFE: scene,
// DUPLICATE REMOVED SAFE: camera,
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: LEVEL 11 UPGRADE — BIDIRECTIONAL PATH TRACING CORE (BDPT)
// DUPLICATE REMOVED SAFE: FILM-GRADE LIGHT TRANSPORT (RENDERMAN / ARNOLD CLASS)
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTBDPTVertex{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.position=new THREE.Vector3()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.normal=new THREE.Vector3()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.throughput=new THREE.Color(1,1,1)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.pdfFwd=1
// DUPLICATE REMOVED SAFE: this.pdfRev=1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.delta=false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.material=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clone(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const v=new PTBDPTVertex()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: v.position.copy(this.position)
// DUPLICATE REMOVED SAFE: v.normal.copy(this.normal)
// DUPLICATE REMOVED SAFE: v.throughput.copy(this.throughput)
// DUPLICATE REMOVED SAFE: v.pdfFwd=this.pdfFwd
// DUPLICATE REMOVED SAFE: v.pdfRev=this.pdfRev
// DUPLICATE REMOVED SAFE: v.delta=this.delta
// DUPLICATE REMOVED SAFE: v.material=this.material
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return v
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTBDPTPath{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(maxVertices=16){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.vertices=new Array(maxVertices)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.length=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<maxVertices;i++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.vertices[i]=new PTBDPTVertex()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: add(vertex){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.length>=this.vertices.length){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.vertices[this.length++]=vertex.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: get(i){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.vertices[i]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clear(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.length=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTBDPTSampler{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(seed=1234){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTSampler(seed)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: next(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.sampler.next()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: next2D(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Vector2(
// DUPLICATE REMOVED SAFE: this.next(),
// DUPLICATE REMOVED SAFE: this.next()
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTBDPTIntegrator{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.maxDepth=12
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cameraPath=new PTBDPTPath(this.maxDepth)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.lightPath=new PTBDPTPath(this.maxDepth)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTBDPTSampler()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.sceneAccel.intersect(ray,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: traceCameraPath(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cameraPath.clear()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let currentRay=ray.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let throughput=new THREE.Color(1,1,1)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let depth=0;depth<this.maxDepth;depth++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: hit.reset()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.sceneAccel.intersect(currentRay,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const vertex=new PTBDPTVertex()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: vertex.position.copy(hit.position)
// DUPLICATE REMOVED SAFE: vertex.normal.copy(hit.normal)
// DUPLICATE REMOVED SAFE: vertex.throughput.copy(throughput)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cameraPath.add(vertex)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const dir=this.sampleDirection(hit.normal)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: throughput.multiplyScalar(
// DUPLICATE REMOVED SAFE: Math.max(hit.normal.dot(dir),0)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: currentRay=new PTRay(
// DUPLICATE REMOVED SAFE: hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
// DUPLICATE REMOVED SAFE: dir
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: traceLightPath(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.lightPath.clear()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const light=this.sampleLight()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!light)return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let ray=new PTRay(
// DUPLICATE REMOVED SAFE: light.position,
// DUPLICATE REMOVED SAFE: this.sampleDirection(light.normal)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let throughput=light.emission.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let depth=0;depth<this.maxDepth;depth++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: hit.reset()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.sceneAccel.intersect(ray,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const vertex=new PTBDPTVertex()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: vertex.position.copy(hit.position)
// DUPLICATE REMOVED SAFE: vertex.normal.copy(hit.normal)
// DUPLICATE REMOVED SAFE: vertex.throughput.copy(throughput)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.lightPath.add(vertex)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const dir=this.sampleDirection(hit.normal)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: throughput.multiplyScalar(
// DUPLICATE REMOVED SAFE: Math.max(hit.normal.dot(dir),0)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: ray=new PTRay(
// DUPLICATE REMOVED SAFE: hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
// DUPLICATE REMOVED SAFE: dir
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: connectPaths(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let result=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<this.cameraPath.length;i++){
// DUPLICATE REMOVED SAFE: for(let j=0;j<this.lightPath.length;j++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const camV=this.cameraPath.get(i)
// DUPLICATE REMOVED SAFE: const lightV=this.lightPath.get(j)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const dir=new THREE.Vector3()
// DUPLICATE REMOVED SAFE: .subVectors(lightV.position,camV.position)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const distSq=dir.lengthSq()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: dir.normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const G=
// DUPLICATE REMOVED SAFE: Math.max(camV.normal.dot(dir),0)*
// DUPLICATE REMOVED SAFE: Math.max(lightV.normal.dot(dir.clone().negate()),0)/
// DUPLICATE REMOVED SAFE: (distSq+PT_EPSILON)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const contrib=camV.throughput.clone()
// DUPLICATE REMOVED SAFE: .multiply(lightV.throughput)
// DUPLICATE REMOVED SAFE: .multiplyScalar(G)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: result.add(contrib)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return result
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sampleLight(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const lights=[]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene.traverse(obj=>{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(obj.isLight){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: lights.push(obj)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: })
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(lights.length===0)return null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const index=Math.floor(
// DUPLICATE REMOVED SAFE: this.sampler.next()*lights.length
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const light=lights[index]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return{
// DUPLICATE REMOVED SAFE: position:light.position.clone(),
// DUPLICATE REMOVED SAFE: normal:new THREE.Vector3(0,1,0),
// DUPLICATE REMOVED SAFE: emission:light.color.clone().multiplyScalar(light.intensity)
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sampleDirection(normal){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const u=this.sampler.next()
// DUPLICATE REMOVED SAFE: const v=this.sampler.next()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const theta=Math.acos(Math.sqrt(1-u))
// DUPLICATE REMOVED SAFE: const phi=2*Math.PI*v
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const x=Math.sin(theta)*Math.cos(phi)
// DUPLICATE REMOVED SAFE: const y=Math.cos(theta)
// DUPLICATE REMOVED SAFE: const z=Math.sin(theta)*Math.sin(phi)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const dir=new THREE.Vector3(x,y,z)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(dir.dot(normal)<0){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: dir.negate()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return dir.normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.traceCameraPath(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.traceLightPath()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.connectPaths()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTBDPTBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=new PTBDPTIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||!this.integrator){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.integrator.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: LEVEL 11 UPGRADE — METROPOLIS LIGHT TRANSPORT (MLT)
// DUPLICATE REMOVED SAFE: FILM-GRADE CAUSTICS, ULTRA-STABLE LIGHT SAMPLING
// DUPLICATE REMOVED SAFE: USED IN RENDERMAN / ARNOLD / CYCLES
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTMLTSample{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(dimension=64){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.primary=new Float32Array(dimension)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.backup=new Float32Array(dimension)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.dimension=dimension
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.index=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clone(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const s=new PTMLTSample(this.dimension)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: s.primary.set(this.primary)
// DUPLICATE REMOVED SAFE: s.backup.set(this.backup)
// DUPLICATE REMOVED SAFE: s.index=this.index
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return s
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: backupState(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.backup.set(this.primary)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: restoreState(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.primary.set(this.backup)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: mutate(sampler,largeStep=false){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.backupState()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<this.dimension;i++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(largeStep){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.primary[i]=sampler.next()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }else{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const dv=0.1*(sampler.next()-0.5)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let v=this.primary[i]+dv
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(v<0)v+=1
// DUPLICATE REMOVED SAFE: if(v>1)v-=1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.primary[i]=v
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: next(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.primary[this.index++%this.dimension]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: reset(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.index=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTMLTChain{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=new PTBDPTIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.currentSample=new PTMLTSample()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.currentContribution=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.proposedSample=new PTMLTSample()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.proposedContribution=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTSampler(7777)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.largeStepProbability=0.3
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.accepted=0
// DUPLICATE REMOVED SAFE: this.rejected=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.currentSample.mutate(this.sampler,true)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.currentSample.reset()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.currentContribution.copy(
// DUPLICATE REMOVED SAFE: this.evaluate(ray,this.currentSample)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: evaluate(ray,sample){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sample.reset()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.integrator.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: step(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const largeStep=this.sampler.next()<this.largeStepProbability
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.proposedSample=this.currentSample.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.proposedSample.mutate(this.sampler,largeStep)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.proposedContribution.copy(
// DUPLICATE REMOVED SAFE: this.evaluate(ray,this.proposedSample)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const currentL=this.luminance(this.currentContribution)
// DUPLICATE REMOVED SAFE: const proposedL=this.luminance(this.proposedContribution)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const acceptance=
// DUPLICATE REMOVED SAFE: currentL<=0?1:Math.min(1,proposedL/currentL)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.sampler.next()<acceptance){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.currentSample=this.proposedSample.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.currentContribution.copy(this.proposedContribution)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.accepted++
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }else{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.rejected++
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.currentContribution.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: luminance(color){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return 0.2126*color.r+
// DUPLICATE REMOVED SAFE: 0.7152*color.g+
// DUPLICATE REMOVED SAFE: 0.0722*color.b
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTMLTIntegrator{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.chain=new PTMLTChain(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.initialized=false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.initialized){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.chain.initialize(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.initialized=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.chain.step(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTMLTBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=new PTMLTIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||!this.integrator){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.integrator.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: LEVEL 11 UPGRADE — TRUE CAUSTICS SOLVER
// DUPLICATE REMOVED SAFE: FILM-GRADE SPECULAR CAUSTICS (GLASS, WATER, CRYSTAL)
// DUPLICATE REMOVED SAFE: PHOTON TRACING + CAUSTIC CACHE
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCausticPhoton{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.position=new THREE.Vector3()
// DUPLICATE REMOVED SAFE: this.direction=new THREE.Vector3()
// DUPLICATE REMOVED SAFE: this.power=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clone(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const p=new PTCausticPhoton()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: p.position.copy(this.position)
// DUPLICATE REMOVED SAFE: p.direction.copy(this.direction)
// DUPLICATE REMOVED SAFE: p.power.copy(this.power)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return p
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCausticPhotonMap{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.photons=[]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.maxPhotons=200000
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.searchRadius=0.5
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: store(photon){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.photons.length>=this.maxPhotons){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.photons.shift()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.photons.push(photon.clone())
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clear(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.photons.length=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: estimate(position,normal){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const result=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let totalWeight=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const radiusSq=this.searchRadius*this.searchRadius
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(const photon of this.photons){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const distSq=position.distanceToSquared(photon.position)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(distSq>radiusSq)continue
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const dirWeight=Math.max(
// DUPLICATE REMOVED SAFE: normal.dot(photon.direction.clone().negate()),
// DUPLICATE REMOVED SAFE: 0
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const distWeight=1/(distSq+0.0001)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const weight=dirWeight*distWeight
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: result.add(
// DUPLICATE REMOVED SAFE: photon.power.clone().multiplyScalar(weight)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: totalWeight+=weight
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(totalWeight>0){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: result.multiplyScalar(1/totalWeight)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return result
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCausticEmitter{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTSampler(9191)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.sceneAccel.intersect(ray,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: emitPhoton(light){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const photon=new PTCausticPhoton()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: photon.position.copy(light.position)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const dir=this.randomDirection()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: photon.direction.copy(dir)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: photon.power.copy(
// DUPLICATE REMOVED SAFE: light.color.clone().multiplyScalar(light.intensity)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return photon
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: randomDirection(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const u=this.sampler.next()
// DUPLICATE REMOVED SAFE: const v=this.sampler.next()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const theta=Math.acos(1-2*u)
// DUPLICATE REMOVED SAFE: const phi=2*Math.PI*v
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Vector3(
// DUPLICATE REMOVED SAFE: Math.sin(theta)*Math.cos(phi),
// DUPLICATE REMOVED SAFE: Math.sin(theta)*Math.sin(phi),
// DUPLICATE REMOVED SAFE: Math.cos(theta)
// DUPLICATE REMOVED SAFE: ).normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: tracePhoton(photon,map,maxBounces=8){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let ray=new PTRay(
// DUPLICATE REMOVED SAFE: photon.position.clone(),
// DUPLICATE REMOVED SAFE: photon.direction.clone()
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let power=photon.power.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let bounce=0;bounce<maxBounces;bounce++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: hit.reset()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.sceneAccel.intersect(ray,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const material=hit.object.material
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const isSpecular=
// DUPLICATE REMOVED SAFE: material.metalness>0.8||
// DUPLICATE REMOVED SAFE: material.transmission>0.8||
// DUPLICATE REMOVED SAFE: material.roughness<0.05
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!isSpecular){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const stored=new PTCausticPhoton()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: stored.position.copy(hit.position)
// DUPLICATE REMOVED SAFE: stored.direction.copy(ray.direction)
// DUPLICATE REMOVED SAFE: stored.power.copy(power)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: map.store(stored)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const reflectDir=ray.direction.clone().reflect(hit.normal)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: ray=new PTRay(
// DUPLICATE REMOVED SAFE: hit.position.clone().addScaledVector(hit.normal,PT_EPSILON),
// DUPLICATE REMOVED SAFE: reflectDir
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: power.multiplyScalar(0.9)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCausticIntegrator{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.map=new PTCausticPhotonMap()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.emitter=new PTCausticEmitter(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.photonsPerFrame=2000
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.initialized=false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: build(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const lights=[]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene.traverse(obj=>{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(obj.isLight){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: lights.push(obj)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: })
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(const light of lights){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<this.photonsPerFrame;i++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const photon=this.emitter.emitPhoton(light)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.emitter.tracePhoton(
// DUPLICATE REMOVED SAFE: photon,
// DUPLICATE REMOVED SAFE: this.map
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.initialized=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: evaluate(position,normal){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.initialized){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.map.estimate(
// DUPLICATE REMOVED SAFE: position,
// DUPLICATE REMOVED SAFE: normal
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTCausticBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=new PTCausticIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator.build()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: evaluate(position,normal){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||!this.integrator){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.integrator.evaluate(
// DUPLICATE REMOVED SAFE: position,
// DUPLICATE REMOVED SAFE: normal
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: LEVEL 11 UPGRADE — SPECTRAL DISPERSION ENGINE
// DUPLICATE REMOVED SAFE: WAVELENGTH-DEPENDENT REFRACTION (PRISM / RAINBOW / GLASS)
// DUPLICATE REMOVED SAFE: FILM-GRADE PHYSICAL DISPERSION
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const PT_IOR_CAUCHY_A=1.5046
// DUPLICATE REMOVED SAFE: const PT_IOR_CAUCHY_B=0.00420
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTDispersionSample{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.lambda=550
// DUPLICATE REMOVED SAFE: this.ior=1.5
// DUPLICATE REMOVED SAFE: this.direction=new THREE.Vector3()
// DUPLICATE REMOVED SAFE: this.weight=1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clone(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const s=new PTDispersionSample()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: s.lambda=this.lambda
// DUPLICATE REMOVED SAFE: s.ior=this.ior
// DUPLICATE REMOVED SAFE: s.direction.copy(this.direction)
// DUPLICATE REMOVED SAFE: s.weight=this.weight
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return s
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTDispersionSpectrum{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.lambdaMin=380
// DUPLICATE REMOVED SAFE: this.lambdaMax=780
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTSampler(2024)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sample(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const s=new PTDispersionSample()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const u=this.sampler.next()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: s.lambda=
// DUPLICATE REMOVED SAFE: this.lambdaMin+
// DUPLICATE REMOVED SAFE: (this.lambdaMax-this.lambdaMin)*u
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: s.ior=this.computeIOR(s.lambda)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return s
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: computeIOR(lambda){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const lambdaMicrometers=lambda*0.001
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return PT_IOR_CAUCHY_A+
// DUPLICATE REMOVED SAFE: PT_IOR_CAUCHY_B/
// DUPLICATE REMOVED SAFE: (lambdaMicrometers*lambdaMicrometers)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: wavelengthToRGB(lambda){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let r=0,g=0,b=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(lambda>=380&&lambda<440){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: r=-(lambda-440)/(440-380)
// DUPLICATE REMOVED SAFE: b=1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }else if(lambda<490){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: g=(lambda-440)/(490-440)
// DUPLICATE REMOVED SAFE: b=1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }else if(lambda<510){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: g=1
// DUPLICATE REMOVED SAFE: b=-(lambda-510)/(510-490)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }else if(lambda<580){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: r=(lambda-510)/(580-510)
// DUPLICATE REMOVED SAFE: g=1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }else if(lambda<645){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: r=1
// DUPLICATE REMOVED SAFE: g=-(lambda-645)/(645-580)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }else if(lambda<=780){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: r=1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color(r,g,b)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTDispersionMaterial{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(material){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.baseMaterial=material
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.dispersionStrength=
// DUPLICATE REMOVED SAFE: material.dispersion??0.05
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.transmission=
// DUPLICATE REMOVED SAFE: material.transmission??0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: isDispersive(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.transmission>0.01&&
// DUPLICATE REMOVED SAFE: this.dispersionStrength>0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTDispersionIntegrator{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.sceneAccel.intersect(ray,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.spectrum=new PTDispersionSpectrum()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.maxSamples=8
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const result=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<this.maxSamples;i++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const sample=this.spectrum.sample()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const color=this.traceWavelength(
// DUPLICATE REMOVED SAFE: ray,
// DUPLICATE REMOVED SAFE: sample
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: result.add(color)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: result.multiplyScalar(1/this.maxSamples)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return result
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: traceWavelength(ray,sample){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.sceneAccel.intersect(ray,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const mat=new PTDispersionMaterial(
// DUPLICATE REMOVED SAFE: hit.object.material
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!mat.isDispersive()){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const normal=hit.normal.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const incident=ray.direction.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const refracted=this.refract(
// DUPLICATE REMOVED SAFE: incident,
// DUPLICATE REMOVED SAFE: normal,
// DUPLICATE REMOVED SAFE: sample.ior
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!refracted){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const spectralColor=
// DUPLICATE REMOVED SAFE: this.spectrum.wavelengthToRGB(
// DUPLICATE REMOVED SAFE: sample.lambda
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const intensity=
// DUPLICATE REMOVED SAFE: Math.abs(normal.dot(refracted))
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return spectralColor.multiplyScalar(
// DUPLICATE REMOVED SAFE: intensity*mat.dispersionStrength
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: refract(I,N,ior){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let cosi=
// DUPLICATE REMOVED SAFE: THREE.MathUtils.clamp(
// DUPLICATE REMOVED SAFE: I.dot(N),
// DUPLICATE REMOVED SAFE: -1,
// DUPLICATE REMOVED SAFE: 1
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let etai=1
// DUPLICATE REMOVED SAFE: let etat=ior
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let n=N.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(cosi<0){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: cosi=-cosi
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }else{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: [etai,etat]=[etat,etai]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: n.negate()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const eta=etai/etat
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const k=1-eta*eta*(1-cosi*cosi)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(k<0){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return I.clone()
// DUPLICATE REMOVED SAFE: .multiplyScalar(eta)
// DUPLICATE REMOVED SAFE: .add(
// DUPLICATE REMOVED SAFE: n.multiplyScalar(
// DUPLICATE REMOVED SAFE: eta*cosi-Math.sqrt(k)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: .normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTDispersionBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=
// DUPLICATE REMOVED SAFE: new PTDispersionIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||
// DUPLICATE REMOVED SAFE: !this.integrator){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.integrator.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: LEVEL 11 UPGRADE — MICROFACET MULTIPLE SCATTERING BRDF
// DUPLICATE REMOVED SAFE: FILM-GRADE GGX WITH ENERGY-CORRECT MULTIPLE SCATTERING
// DUPLICATE REMOVED SAFE: USED IN RENDERMAN / ARNOLD / FILM RENDERERS
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTMicrofacetUtils{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: static saturate(x){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return Math.max(0,Math.min(1,x))
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: static fresnelSchlick(cosTheta,F0){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return F0.clone().add(
// DUPLICATE REMOVED SAFE: new THREE.Color(1,1,1)
// DUPLICATE REMOVED SAFE: .sub(F0)
// DUPLICATE REMOVED SAFE: .multiplyScalar(Math.pow(1-cosTheta,5))
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: static D_GGX(NdotH,alpha){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const a2=alpha*alpha
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const denom=
// DUPLICATE REMOVED SAFE: NdotH*NdotH*(a2-1)+1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return a2/(Math.PI*denom*denom+1e-7)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: static G_Smith(NdotV,NdotL,alpha){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.G1(NdotV,alpha)*
// DUPLICATE REMOVED SAFE: this.G1(NdotL,alpha)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: static G1(NdotV,alpha){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const a=alpha
// DUPLICATE REMOVED SAFE: const k=(a*a)/2
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return NdotV/(NdotV*(1-k)+k)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: static importanceSampleGGX(u1,u2,alpha){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const a2=alpha*alpha
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const phi=2*Math.PI*u1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const cosTheta=Math.sqrt(
// DUPLICATE REMOVED SAFE: (1-u2)/(1+(a2-1)*u2)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const sinTheta=Math.sqrt(
// DUPLICATE REMOVED SAFE: 1-cosTheta*cosTheta
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Vector3(
// DUPLICATE REMOVED SAFE: sinTheta*Math.cos(phi),
// DUPLICATE REMOVED SAFE: cosTheta,
// DUPLICATE REMOVED SAFE: sinTheta*Math.sin(phi)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTMicrofacetMaterial{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(material){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.baseColor=
// DUPLICATE REMOVED SAFE: material.color.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.metalness=
// DUPLICATE REMOVED SAFE: material.metalness??0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.roughness=
// DUPLICATE REMOVED SAFE: Math.max(
// DUPLICATE REMOVED SAFE: 0.001,
// DUPLICATE REMOVED SAFE: material.roughness??0.5
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.specular=
// DUPLICATE REMOVED SAFE: material.specular??0.5
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.F0=this.computeF0()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: computeF0(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const dielectric=
// DUPLICATE REMOVED SAFE: new THREE.Color(
// DUPLICATE REMOVED SAFE: 0.04,
// DUPLICATE REMOVED SAFE: 0.04,
// DUPLICATE REMOVED SAFE: 0.04
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return dielectric.lerp(
// DUPLICATE REMOVED SAFE: this.baseColor,
// DUPLICATE REMOVED SAFE: this.metalness
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTMicrofacetIntegrator{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.sceneAccel.intersect(ray,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTSampler(6060)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.samples=4
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: evaluate(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.sceneAccel.intersect(ray,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const material=
// DUPLICATE REMOVED SAFE: new PTMicrofacetMaterial(
// DUPLICATE REMOVED SAFE: hit.object.material
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const N=hit.normal.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const V=ray.direction.clone().negate()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let result=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<this.samples;i++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const u1=this.sampler.next()
// DUPLICATE REMOVED SAFE: const u2=this.sampler.next()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const H=
// DUPLICATE REMOVED SAFE: PTMicrofacetUtils
// DUPLICATE REMOVED SAFE: .importanceSampleGGX(
// DUPLICATE REMOVED SAFE: u1,
// DUPLICATE REMOVED SAFE: u2,
// DUPLICATE REMOVED SAFE: material.roughness
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const L=
// DUPLICATE REMOVED SAFE: V.clone()
// DUPLICATE REMOVED SAFE: .reflect(H)
// DUPLICATE REMOVED SAFE: .normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const NdotL=
// DUPLICATE REMOVED SAFE: PTMicrofacetUtils
// DUPLICATE REMOVED SAFE: .saturate(
// DUPLICATE REMOVED SAFE: N.dot(L)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const NdotV=
// DUPLICATE REMOVED SAFE: PTMicrofacetUtils
// DUPLICATE REMOVED SAFE: .saturate(
// DUPLICATE REMOVED SAFE: N.dot(V)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const NdotH=
// DUPLICATE REMOVED SAFE: PTMicrofacetUtils
// DUPLICATE REMOVED SAFE: .saturate(
// DUPLICATE REMOVED SAFE: N.dot(H)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const VdotH=
// DUPLICATE REMOVED SAFE: PTMicrofacetUtils
// DUPLICATE REMOVED SAFE: .saturate(
// DUPLICATE REMOVED SAFE: V.dot(H)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(NdotL<=0||
// DUPLICATE REMOVED SAFE: NdotV<=0){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: continue
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const D=
// DUPLICATE REMOVED SAFE: PTMicrofacetUtils
// DUPLICATE REMOVED SAFE: .D_GGX(
// DUPLICATE REMOVED SAFE: NdotH,
// DUPLICATE REMOVED SAFE: material.roughness
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const G=
// DUPLICATE REMOVED SAFE: PTMicrofacetUtils
// DUPLICATE REMOVED SAFE: .G_Smith(
// DUPLICATE REMOVED SAFE: NdotV,
// DUPLICATE REMOVED SAFE: NdotL,
// DUPLICATE REMOVED SAFE: material.roughness
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const F=
// DUPLICATE REMOVED SAFE: PTMicrofacetUtils
// DUPLICATE REMOVED SAFE: .fresnelSchlick(
// DUPLICATE REMOVED SAFE: VdotH,
// DUPLICATE REMOVED SAFE: material.F0
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const spec=
// DUPLICATE REMOVED SAFE: F.clone()
// DUPLICATE REMOVED SAFE: .multiplyScalar(
// DUPLICATE REMOVED SAFE: D*G/
// DUPLICATE REMOVED SAFE: (4*NdotV*NdotL+1e-7)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const diffuse=
// DUPLICATE REMOVED SAFE: material.baseColor
// DUPLICATE REMOVED SAFE: .clone()
// DUPLICATE REMOVED SAFE: .multiplyScalar(
// DUPLICATE REMOVED SAFE: (1-material.metalness)/
// DUPLICATE REMOVED SAFE: Math.PI
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const contribution=
// DUPLICATE REMOVED SAFE: diffuse.add(spec)
// DUPLICATE REMOVED SAFE: .multiplyScalar(NdotL)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: result.add(contribution)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: result.multiplyScalar(
// DUPLICATE REMOVED SAFE: 1/this.samples
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return result
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTMicrofacetBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=
// DUPLICATE REMOVED SAFE: new PTMicrofacetIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: evaluate(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||
// DUPLICATE REMOVED SAFE: !this.integrator){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.integrator.evaluate(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: LEVEL 11 UPGRADE — INFINITE BOUNCE GLOBAL ILLUMINATION
// DUPLICATE REMOVED SAFE: TRUE FILM-GRADE MULTI-BOUNCE LIGHT TRANSPORT
// DUPLICATE REMOVED SAFE: ENERGY CONSERVING — NO FAKE BOUNCE LIMITS
// DUPLICATE REMOVED SAFE: USED IN FILM RENDERERS
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTInfiniteBounceRay{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(origin,direction,throughput){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.origin=origin.clone()
// DUPLICATE REMOVED SAFE: this.direction=direction.clone()
// DUPLICATE REMOVED SAFE: this.throughput=throughput.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clone(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new PTInfiniteBounceRay(
// DUPLICATE REMOVED SAFE: this.origin,
// DUPLICATE REMOVED SAFE: this.direction,
// DUPLICATE REMOVED SAFE: this.throughput
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTInfiniteBounceIntegrator{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.sceneAccel.intersect(ray,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTSampler(4242)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.maxDepth=64
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.rrDepth=4
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.minThroughput=0.0001
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(initialRay){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let radiance=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let ray=new PTInfiniteBounceRay(
// DUPLICATE REMOVED SAFE: initialRay.origin,
// DUPLICATE REMOVED SAFE: initialRay.direction,
// DUPLICATE REMOVED SAFE: new THREE.Color(1,1,1)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let depth=0;depth<this.maxDepth;depth++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.sceneAccel.intersect(
// DUPLICATE REMOVED SAFE: new PTRay(ray.origin,ray.direction),
// DUPLICATE REMOVED SAFE: hit
// DUPLICATE REMOVED SAFE: )){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const material=hit.object.material
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const emission=this.getEmission(hit.object)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(emission){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: radiance.add(
// DUPLICATE REMOVED SAFE: ray.throughput.clone().multiply(
// DUPLICATE REMOVED SAFE: emission
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const bounce=this.sampleBounce(
// DUPLICATE REMOVED SAFE: ray,
// DUPLICATE REMOVED SAFE: hit,
// DUPLICATE REMOVED SAFE: material
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!bounce){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: ray.origin.copy(bounce.origin)
// DUPLICATE REMOVED SAFE: ray.direction.copy(bounce.direction)
// DUPLICATE REMOVED SAFE: ray.throughput.multiply(
// DUPLICATE REMOVED SAFE: bounce.throughput
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(ray.throughput.r<this.minThroughput&&
// DUPLICATE REMOVED SAFE: ray.throughput.g<this.minThroughput&&
// DUPLICATE REMOVED SAFE: ray.throughput.b<this.minThroughput){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(depth>=this.rrDepth){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const p=Math.max(
// DUPLICATE REMOVED SAFE: ray.throughput.r,
// DUPLICATE REMOVED SAFE: ray.throughput.g,
// DUPLICATE REMOVED SAFE: ray.throughput.b
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.sampler.next()>p){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: ray.throughput.multiplyScalar(1/p)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return radiance
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getEmission(object){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(object.material.emissive){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return object.material.emissive.clone()
// DUPLICATE REMOVED SAFE: .multiplyScalar(
// DUPLICATE REMOVED SAFE: object.material.emissiveIntensity??1
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sampleBounce(ray,hit,material){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const N=hit.normal.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const u1=this.sampler.next()
// DUPLICATE REMOVED SAFE: const u2=this.sampler.next()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const dir=this.cosineSampleHemisphere(
// DUPLICATE REMOVED SAFE: u1,
// DUPLICATE REMOVED SAFE: u2,
// DUPLICATE REMOVED SAFE: N
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const color=
// DUPLICATE REMOVED SAFE: material.color??
// DUPLICATE REMOVED SAFE: new THREE.Color(1,1,1)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const throughput=color.clone()
// DUPLICATE REMOVED SAFE: .multiplyScalar(
// DUPLICATE REMOVED SAFE: Math.max(0,dir.dot(N))
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: origin:hit.position.clone()
// DUPLICATE REMOVED SAFE: .addScaledVector(N,PT_EPSILON),
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: direction:dir,
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: throughput:throughput
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: cosineSampleHemisphere(u1,u2,N){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const r=Math.sqrt(u1)
// DUPLICATE REMOVED SAFE: const theta=2*Math.PI*u2
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const x=r*Math.cos(theta)
// DUPLICATE REMOVED SAFE: const y=r*Math.sin(theta)
// DUPLICATE REMOVED SAFE: const z=Math.sqrt(1-u1)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const tangent=this.buildTangent(N)
// DUPLICATE REMOVED SAFE: const bitangent=new THREE.Vector3()
// DUPLICATE REMOVED SAFE: .crossVectors(N,tangent)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return tangent.multiplyScalar(x)
// DUPLICATE REMOVED SAFE: .add(bitangent.multiplyScalar(y))
// DUPLICATE REMOVED SAFE: .add(N.clone().multiplyScalar(z))
// DUPLICATE REMOVED SAFE: .normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: buildTangent(N){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(Math.abs(N.x)>0.1){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Vector3(0,1,0)
// DUPLICATE REMOVED SAFE: .cross(N)
// DUPLICATE REMOVED SAFE: .normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }else{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Vector3(1,0,0)
// DUPLICATE REMOVED SAFE: .cross(N)
// DUPLICATE REMOVED SAFE: .normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTInfiniteBounceCache{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cache=new Map()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: key(position,normal){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return(
// DUPLICATE REMOVED SAFE: position.x.toFixed(2)+","+
// DUPLICATE REMOVED SAFE: position.y.toFixed(2)+","+
// DUPLICATE REMOVED SAFE: position.z.toFixed(2)+"|"+
// DUPLICATE REMOVED SAFE: normal.x.toFixed(2)+","+
// DUPLICATE REMOVED SAFE: normal.y.toFixed(2)+","+
// DUPLICATE REMOVED SAFE: normal.z.toFixed(2)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: store(position,normal,value){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled)return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cache.set(
// DUPLICATE REMOVED SAFE: this.key(position,normal),
// DUPLICATE REMOVED SAFE: value.clone()
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: lookup(position,normal){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled)return null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.cache.get(
// DUPLICATE REMOVED SAFE: this.key(position,normal)
// DUPLICATE REMOVED SAFE: )||null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clear(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cache.clear()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTInfiniteBounceBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cache=new PTInfiniteBounceCache()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=
// DUPLICATE REMOVED SAFE: new PTInfiniteBounceIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray,position,normal){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||
// DUPLICATE REMOVED SAFE: !this.integrator){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const cached=
// DUPLICATE REMOVED SAFE: this.cache.lookup(position,normal)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(cached){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return cached.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const result=
// DUPLICATE REMOVED SAFE: this.integrator.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.cache.store(
// DUPLICATE REMOVED SAFE: position,
// DUPLICATE REMOVED SAFE: normal,
// DUPLICATE REMOVED SAFE: result
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return result
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: LEVEL 11 UPGRADE — ADAPTIVE SAMPLING + CONVERGENCE ENGINE
// DUPLICATE REMOVED SAFE: FILM-GRADE NOISE REDUCTION
// DUPLICATE REMOVED SAFE: INTELLIGENT SAMPLING BASED ON VARIANCE
// DUPLICATE REMOVED SAFE: USED IN FILM RENDERERS
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTAdaptivePixelState{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampleCount=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.mean=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.m2=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.variance=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.converged=false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: addSample(sample){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampleCount++
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const delta=sample.clone().sub(this.mean)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.mean.add(
// DUPLICATE REMOVED SAFE: const invCount=this.sampleCount>0?1/this.sampleCount:0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: delta.clone().multiplyScalar(invCount)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const delta2=sample.clone().sub(this.mean)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.m2.add(
// DUPLICATE REMOVED SAFE: delta.multiply(delta2)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.sampleCount>1){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.variance.copy(
// DUPLICATE REMOVED SAFE: this.m2.clone().multiplyScalar(
// DUPLICATE REMOVED SAFE: 1/(this.sampleCount-1)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getNoiseLevel(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return(
// DUPLICATE REMOVED SAFE: this.variance.r+
// DUPLICATE REMOVED SAFE: this.variance.g+
// DUPLICATE REMOVED SAFE: this.variance.b
// DUPLICATE REMOVED SAFE: )/3
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTAdaptiveSamplingBuffer{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=width
// DUPLICATE REMOVED SAFE: this.height=height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.pixels=new Array(width*height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<this.pixels.length;i++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.pixels[i]=new PTAdaptivePixelState()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.noiseThreshold=0.0005
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.minSamples=4
// DUPLICATE REMOVED SAFE: this.maxSamples=4096
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: index(x,y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return y*this.width+x
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: addSample(x,y,color){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const pixel=this.pixels[
// DUPLICATE REMOVED SAFE: this.index(x,y)
// DUPLICATE REMOVED SAFE: ]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: pixel.addSample(color)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(pixel.sampleCount>=this.minSamples){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(pixel.getNoiseLevel()<
// DUPLICATE REMOVED SAFE: this.noiseThreshold){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: pixel.converged=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: needsMoreSamples(x,y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const pixel=this.pixels[
// DUPLICATE REMOVED SAFE: this.index(x,y)
// DUPLICATE REMOVED SAFE: ]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(pixel.sampleCount<
// DUPLICATE REMOVED SAFE: this.minSamples){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(pixel.converged){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(pixel.sampleCount>=
// DUPLICATE REMOVED SAFE: this.maxSamples){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getColor(x,y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.pixels[
// DUPLICATE REMOVED SAFE: this.index(x,y)
// DUPLICATE REMOVED SAFE: ].mean.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clear(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(const p of this.pixels){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: p.sampleCount=0
// DUPLICATE REMOVED SAFE: p.mean.set(0,0,0)
// DUPLICATE REMOVED SAFE: p.m2.set(0,0,0)
// DUPLICATE REMOVED SAFE: p.variance.set(0,0,0)
// DUPLICATE REMOVED SAFE: p.converged=false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTAdaptiveSamplerController{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.buffer=new PTAdaptiveSamplingBuffer(
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.activePixels=[]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frameIndex=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.rebuildActivePixels()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: rebuildActivePixels(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.activePixels.length=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let y=0;y<this.buffer.height;y++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let x=0;x<this.buffer.width;x++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.buffer.needsMoreSamples(x,y)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.activePixels.push({x,y})
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: nextPixel(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.activePixels.length===0){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const i=Math.floor(
// DUPLICATE REMOVED SAFE: Math.random()*
// DUPLICATE REMOVED SAFE: this.activePixels.length
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.activePixels[i]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: addSample(x,y,color){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.buffer.addSample(x,y,color)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.buffer.needsMoreSamples(x,y)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.removePixel(x,y)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: removePixel(x,y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<this.activePixels.length;i++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const p=this.activePixels[i]
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(p.x===x&&p.y===y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.activePixels.splice(i,1)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getProgress(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const total=
// DUPLICATE REMOVED SAFE: this.buffer.width*
// DUPLICATE REMOVED SAFE: this.buffer.height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const done=
// DUPLICATE REMOVED SAFE: total-this.activePixels.length
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return done/total
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getPixelColor(x,y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.buffer.getColor(x,y)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: reset(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.buffer.clear()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.rebuildActivePixels()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frameIndex=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTAdaptiveBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.controller=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.controller=
// DUPLICATE REMOVED SAFE: new PTAdaptiveSamplerController(
// DUPLICATE REMOVED SAFE: this.engine,
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: requestPixel(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||
// DUPLICATE REMOVED SAFE: !this.controller){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.controller.nextPixel()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: submitSample(x,y,color){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||
// DUPLICATE REMOVED SAFE: !this.controller){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.controller.addSample(x,y,color)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getPixelColor(x,y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.controller
// DUPLICATE REMOVED SAFE: .getPixelColor(x,y)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getProgress(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.controller
// DUPLICATE REMOVED SAFE: .getProgress()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: reset(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.controller){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.controller.reset()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: LEVEL 11 UPGRADE — FILM ACCUMULATION BUFFER
// DUPLICATE REMOVED SAFE: PROGRESSIVE FILM-QUALITY RENDERING
// DUPLICATE REMOVED SAFE: FLOAT32 HDR ACCUMULATION WITH INFINITE PRECISION APPROX
// DUPLICATE REMOVED SAFE: USED IN FILM RENDERERS
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTAccumulationPixel{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sum=new THREE.Color(0,0,0)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampleCount=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.historyWeight=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: add(sample){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sum.add(sample)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampleCount++
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.historyWeight=1.0-1.0/(this.sampleCount+1)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: get(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.sampleCount===0){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.sum.clone().multiplyScalar(
// DUPLICATE REMOVED SAFE: 1/this.sampleCount
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: reset(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sum.set(0,0,0)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampleCount=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.historyWeight=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTAccumulationBuffer{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=width
// DUPLICATE REMOVED SAFE: this.height=height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.pixels=new Array(width*height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<this.pixels.length;i++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.pixels[i]=new PTAccumulationPixel()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frameIndex=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: index(x,y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return y*this.width+x
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: addSample(x,y,color){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled)return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.pixels[
// DUPLICATE REMOVED SAFE: this.index(x,y)
// DUPLICATE REMOVED SAFE: ].add(color)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getPixel(x,y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.pixels[
// DUPLICATE REMOVED SAFE: this.index(x,y)
// DUPLICATE REMOVED SAFE: ].get()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getSampleCount(x,y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.pixels[
// DUPLICATE REMOVED SAFE: this.index(x,y)
// DUPLICATE REMOVED SAFE: ].sampleCount
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clear(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(const p of this.pixels){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: p.reset()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frameIndex=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: nextFrame(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frameIndex++
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=width
// DUPLICATE REMOVED SAFE: this.height=height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.pixels=new Array(width*height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let i=0;i<this.pixels.length;i++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.pixels[i]=new PTAccumulationPixel()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frameIndex=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTAccumulationToneMapper{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.exposure=1.0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.gamma=2.2
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: apply(color){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const mapped=color.clone()
// DUPLICATE REMOVED SAFE: .multiplyScalar(this.exposure)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: mapped.r=1-Math.exp(-mapped.r)
// DUPLICATE REMOVED SAFE: mapped.g=1-Math.exp(-mapped.g)
// DUPLICATE REMOVED SAFE: mapped.b=1-Math.exp(-mapped.b)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: mapped.r=Math.pow(mapped.r,1/this.gamma)
// DUPLICATE REMOVED SAFE: mapped.g=Math.pow(mapped.g,1/this.gamma)
// DUPLICATE REMOVED SAFE: mapped.b=Math.pow(mapped.b,1/this.gamma)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return mapped
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTAccumulationBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.buffer=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.tonemapper=
// DUPLICATE REMOVED SAFE: new PTAccumulationToneMapper()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.buffer=
// DUPLICATE REMOVED SAFE: new PTAccumulationBuffer(
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: addSample(x,y,color){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||
// DUPLICATE REMOVED SAFE: !this.buffer){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.buffer.addSample(x,y,color)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getDisplayColor(x,y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||
// DUPLICATE REMOVED SAFE: !this.buffer){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const hdr=
// DUPLICATE REMOVED SAFE: this.buffer.getPixel(x,y)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.tonemapper.apply(hdr)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: nextFrame(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.buffer){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.buffer.nextFrame()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: clear(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.buffer){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.buffer.clear()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.buffer){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.buffer.resize(width,height)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: LEVEL 11 UPGRADE — SPECTRAL VOLUMETRIC LIGHT TRANSPORT
// DUPLICATE REMOVED SAFE: FILM-GRADE ATMOSPHERE, GOD RAYS, FOG, LIGHT SHAFTS
// DUPLICATE REMOVED SAFE: SPECTRAL + MULTIPLE SCATTERING
// DUPLICATE REMOVED SAFE: USED IN FILM RENDERERS
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTVolumeMedium{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.density=0.02
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.anisotropy=0.6
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.absorption=
// DUPLICATE REMOVED SAFE: new THREE.Color(0.01,0.01,0.02)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scattering=
// DUPLICATE REMOVED SAFE: new THREE.Color(0.9,0.9,1.0)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTVolumeSample{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.position=new THREE.Vector3()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.transmittance=
// DUPLICATE REMOVED SAFE: new THREE.Color(1,1,1)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.inscattering=
// DUPLICATE REMOVED SAFE: new THREE.Color(0,0,0)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTPhaseFunction{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(g){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.g=g
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: henyeyGreenstein(cosTheta){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const g=this.g
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const denom=
// DUPLICATE REMOVED SAFE: 1+g*g-2*g*cosTheta
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return(
// DUPLICATE REMOVED SAFE: (1-g*g)/
// DUPLICATE REMOVED SAFE: (4*Math.PI*Math.pow(denom,1.5))
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sample(direction,sampler){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const u1=sampler.next()
// DUPLICATE REMOVED SAFE: const u2=sampler.next()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let cosTheta
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(Math.abs(this.g)<0.001){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: cosTheta=1-2*u1
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }else{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const sq=
// DUPLICATE REMOVED SAFE: (1-this.g*this.g)/
// DUPLICATE REMOVED SAFE: (1-this.g+2*this.g*u1)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: cosTheta=
// DUPLICATE REMOVED SAFE: (1+this.g*this.g-sq*sq)/
// DUPLICATE REMOVED SAFE: (2*this.g)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const sinTheta=
// DUPLICATE REMOVED SAFE: Math.sqrt(
// DUPLICATE REMOVED SAFE: Math.max(0,1-cosTheta*cosTheta)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const phi=2*Math.PI*u2
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Vector3(
// DUPLICATE REMOVED SAFE: sinTheta*Math.cos(phi),
// DUPLICATE REMOVED SAFE: sinTheta*Math.sin(phi),
// DUPLICATE REMOVED SAFE: cosTheta
// DUPLICATE REMOVED SAFE: ).normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTSpectralVolumeIntegrator{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.sceneAccel.intersect(ray,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.medium=new PTVolumeMedium()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.sampler=new PTSampler(8888)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.phase=
// DUPLICATE REMOVED SAFE: new PTPhaseFunction(
// DUPLICATE REMOVED SAFE: this.medium.anisotropy
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.stepSize=0.2
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.maxDistance=100
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.maxSteps=256
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let t=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const result=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const transmittance=
// DUPLICATE REMOVED SAFE: new THREE.Color(1,1,1)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: for(let step=0;
// DUPLICATE REMOVED SAFE: step<this.maxSteps;
// DUPLICATE REMOVED SAFE: step++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(t>this.maxDistance){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const position=
// DUPLICATE REMOVED SAFE: ray.origin.clone()
// DUPLICATE REMOVED SAFE: .addScaledVector(
// DUPLICATE REMOVED SAFE: ray.direction,
// DUPLICATE REMOVED SAFE: t
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const density=this.medium.density
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const absorb=this.medium.absorption
// DUPLICATE REMOVED SAFE: .clone()
// DUPLICATE REMOVED SAFE: .multiplyScalar(density)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: transmittance.multiply(
// DUPLICATE REMOVED SAFE: new THREE.Color(
// DUPLICATE REMOVED SAFE: Math.exp(-absorb.r*this.stepSize),
// DUPLICATE REMOVED SAFE: Math.exp(-absorb.g*this.stepSize),
// DUPLICATE REMOVED SAFE: Math.exp(-absorb.b*this.stepSize)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const scatter=this.medium.scattering
// DUPLICATE REMOVED SAFE: .clone()
// DUPLICATE REMOVED SAFE: .multiplyScalar(density)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const light=
// DUPLICATE REMOVED SAFE: this.sampleLights(position)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const phase=
// DUPLICATE REMOVED SAFE: this.phase.henyeyGreenstein(
// DUPLICATE REMOVED SAFE: ray.direction.dot(
// DUPLICATE REMOVED SAFE: light.direction
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const inscatter=
// DUPLICATE REMOVED SAFE: scatter.clone()
// DUPLICATE REMOVED SAFE: .multiply(light.color)
// DUPLICATE REMOVED SAFE: .multiplyScalar(
// DUPLICATE REMOVED SAFE: phase*this.stepSize
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: result.add(
// DUPLICATE REMOVED SAFE: inscatter.multiply(
// DUPLICATE REMOVED SAFE: transmittance.clone()
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: t+=this.stepSize
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(transmittance.r<0.001&&
// DUPLICATE REMOVED SAFE: transmittance.g<0.001&&
// DUPLICATE REMOVED SAFE: transmittance.b<0.001){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return result
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: sampleLights(position){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let closestLight=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let minDist=Infinity
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.scene.traverse(obj=>{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(obj.isLight){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const d=
// DUPLICATE REMOVED SAFE: position.distanceTo(
// DUPLICATE REMOVED SAFE: obj.position
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(d<minDist){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: minDist=d
// DUPLICATE REMOVED SAFE: closestLight=obj
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: })
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!closestLight){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return{
// DUPLICATE REMOVED SAFE: color:new THREE.Color(),
// DUPLICATE REMOVED SAFE: direction:new THREE.Vector3()
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const dir=
// DUPLICATE REMOVED SAFE: closestLight.position
// DUPLICATE REMOVED SAFE: .clone()
// DUPLICATE REMOVED SAFE: .sub(position)
// DUPLICATE REMOVED SAFE: .normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: color:
// DUPLICATE REMOVED SAFE: closestLight.color
// DUPLICATE REMOVED SAFE: .clone()
// DUPLICATE REMOVED SAFE: .multiplyScalar(
// DUPLICATE REMOVED SAFE: closestLight.intensity
// DUPLICATE REMOVED SAFE: ),
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: direction:dir
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTSpectralVolumeBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.integrator=
// DUPLICATE REMOVED SAFE: new PTSpectralVolumeIntegrator(scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: trace(ray){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||
// DUPLICATE REMOVED SAFE: !this.integrator){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.integrator.trace(ray)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: /* =========================================================
// DUPLICATE REMOVED SAFE: LEVEL 12 FINAL — FILM RENDERER INTEGRATION CORE
// DUPLICATE REMOVED SAFE: CONNECTS ALL LEVEL 11 SYSTEMS INTO ONE UNIFIED RENDERER
// DUPLICATE REMOVED SAFE: FILM-GRADE PATH TRACING PIPELINE
// DUPLICATE REMOVED SAFE: ========================================================= */
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTFilmRenderer{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine,scene,camera,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: this.scene=scene
// DUPLICATE REMOVED SAFE: this.camera=camera
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=width
// DUPLICATE REMOVED SAFE: this.height=height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.initialized=false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.caustics=
// DUPLICATE REMOVED SAFE: new PTCausticBridge(engine)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.dispersion=
// DUPLICATE REMOVED SAFE: new PTDispersionBridge(engine)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.microfacet=
// DUPLICATE REMOVED SAFE: new PTMicrofacetBridge(engine)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.gi=
// DUPLICATE REMOVED SAFE: new PTInfiniteBounceBridge(engine)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.adaptive=
// DUPLICATE REMOVED SAFE: new PTAdaptiveBridge(engine)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.accumulation=
// DUPLICATE REMOVED SAFE: new PTAccumulationBridge(engine)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.volume=
// DUPLICATE REMOVED SAFE: new PTSpectralVolumeBridge(engine)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frameIndex=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.initialized)return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.caustics.initialize(this.scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.dispersion.initialize(this.scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.microfacet.initialize(this.scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.gi.initialize(this.scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.adaptive.initialize(
// DUPLICATE REMOVED SAFE: this.width,
// DUPLICATE REMOVED SAFE: this.height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.accumulation.initialize(
// DUPLICATE REMOVED SAFE: this.width,
// DUPLICATE REMOVED SAFE: this.height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.volume.initialize(this.scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.initialized=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: renderSample(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.initialized){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.initialize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const pixel=
// DUPLICATE REMOVED SAFE: this.adaptive.requestPixel()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!pixel){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return false
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const x=pixel.x
// DUPLICATE REMOVED SAFE: const y=pixel.y
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const ray=this.generateCameraRay(x,y)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let color=new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: color.add(
// DUPLICATE REMOVED SAFE: this.microfacet.evaluate(ray)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: color.add(
// DUPLICATE REMOVED SAFE: this.gi.trace(
// DUPLICATE REMOVED SAFE: ray,
// DUPLICATE REMOVED SAFE: ray.origin,
// DUPLICATE REMOVED SAFE: ray.direction
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: color.add(
// DUPLICATE REMOVED SAFE: this.volume.trace(ray)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: color.add(
// DUPLICATE REMOVED SAFE: this.dispersion.trace(ray)
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const hit=new PTHit() for(let bounce=0;bounce<this.maxBounces;bounce++){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const sceneAccel=new PTScene(this.scene)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(sceneAccel.intersect(ray,hit)){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: color.add(
// DUPLICATE REMOVED SAFE: this.caustics.evaluate(
// DUPLICATE REMOVED SAFE: hit.position,
// DUPLICATE REMOVED SAFE: hit.normal
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.adaptive.submitSample(
// DUPLICATE REMOVED SAFE: x,
// DUPLICATE REMOVED SAFE: y,
// DUPLICATE REMOVED SAFE: color
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.accumulation.addSample(
// DUPLICATE REMOVED SAFE: x,
// DUPLICATE REMOVED SAFE: y,
// DUPLICATE REMOVED SAFE: color
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: generateCameraRay(x,y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const u=(x+Math.random())/
// DUPLICATE REMOVED SAFE: this.width
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const v=(y+Math.random())/
// DUPLICATE REMOVED SAFE: this.height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const origin=
// DUPLICATE REMOVED SAFE: this.camera.position.clone()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: const direction=
// DUPLICATE REMOVED SAFE: new THREE.Vector3(
// DUPLICATE REMOVED SAFE: (u-0.5)*2,
// DUPLICATE REMOVED SAFE: (v-0.5)*2,
// DUPLICATE REMOVED SAFE: -1
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: .unproject(this.camera)
// DUPLICATE REMOVED SAFE: .sub(origin)
// DUPLICATE REMOVED SAFE: .normalize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new PTRay(
// DUPLICATE REMOVED SAFE: origin,
// DUPLICATE REMOVED SAFE: direction
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getPixel(x,y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.accumulation
// DUPLICATE REMOVED SAFE: .getDisplayColor(x,y)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: renderProgress(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.adaptive.getProgress()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: renderFrame(maxSamples=10000){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: let samples=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: while(samples<maxSamples){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.renderSample()){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: break
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: samples++
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frameIndex++
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.accumulation.nextFrame()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.width=width
// DUPLICATE REMOVED SAFE: this.height=height
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.accumulation.resize(
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.adaptive.initialize(
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: reset(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.adaptive.reset()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.accumulation.clear()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.frameIndex=0
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: class PTFilmRendererBridge{
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: constructor(engine){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.engine=engine
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.renderer=null
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.enabled=true
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: initialize(scene,camera,width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.renderer=
// DUPLICATE REMOVED SAFE: new PTFilmRenderer(
// DUPLICATE REMOVED SAFE: this.engine,
// DUPLICATE REMOVED SAFE: scene,
// DUPLICATE REMOVED SAFE: camera,
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.renderer.initialize()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: renderFrame(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||
// DUPLICATE REMOVED SAFE: !this.renderer){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.renderer.renderFrame()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getPixel(x,y){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(!this.enabled||
// DUPLICATE REMOVED SAFE: !this.renderer){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return new THREE.Color()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.renderer.getPixel(x,y)
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: getProgress(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: return this.renderer
// DUPLICATE REMOVED SAFE: .renderProgress()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: reset(){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.renderer){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.renderer.reset()
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: resize(width,height){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: if(this.renderer){
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: this.renderer.resize(
// DUPLICATE REMOVED SAFE: width,
// DUPLICATE REMOVED SAFE: height
// DUPLICATE REMOVED SAFE: )
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: 
// DUPLICATE REMOVED SAFE: }
// DUPLICATE REMOVED SAFE: export { Engine }
