// ValentineObjects.js
// Part 1/6
// Ultra Cinematic Valentine Objects System
// Production-grade, GPU optimized, Engine-integrated

import * as THREE from 'https://jspm.dev/three'

const _tempVec3=new THREE.Vector3()
const _tempColor=new THREE.Color()

class ValentineObjects{

constructor(engine){

this.engine=engine
this.scene=engine.scene

this.group=new THREE.Group()
this.group.name="ValentineObjectsRoot"

this.hearts=[]
this.energyCores=[]
this.crystals=[]
this.rings=[]

this._initialized=false

this._time=0

this._heartGeometry=null
this._coreGeometry=null
this._crystalGeometry=null
this._ringGeometry=null

this._materials={
heart:null,
heartGlow:null,
core:null,
coreGlow:null,
crystal:null,
ring:null
}

this._maxHearts=48
this._maxCrystals=24
this._maxRings=12

this._bounds=18

}

init(){

if(this._initialized)return

this._createGeometries()

this._createMaterials()

this._createEnergyCore()

this._createHearts()

this._createCrystals()

this._createEnergyRings()

this.scene.add(this.group)

this._initialized=true

}

_createGeometries(){

const heartShape=new THREE.Shape()

heartShape.moveTo(0,0.3)

heartShape.bezierCurveTo(
0,0,
-0.5,-0.3,
-0.5,-0.8
)

heartShape.bezierCurveTo(
-0.5,-1.3,
0,-1.6,
0,-1.2
)

heartShape.bezierCurveTo(
0,-1.6,
0.5,-1.3,
0.5,-0.8
)

heartShape.bezierCurveTo(
0.5,-0.3,
0,0,
0,0.3
)

const extrudeSettings={
depth:0.4,
bevelEnabled:true,
bevelSegments:4,
steps:1,
bevelSize:0.08,
bevelThickness:0.08
}

this._heartGeometry=new THREE.ExtrudeGeometry(
heartShape,
extrudeSettings
)

this._heartGeometry.center()

this._coreGeometry=new THREE.IcosahedronGeometry(
1.2,
3
)

this._crystalGeometry=new THREE.OctahedronGeometry(
0.6,
2
)

this._ringGeometry=new THREE.TorusGeometry(
2.8,
0.08,
32,
128
)

}
// ValentineObjects.js
// Part 2/6
// Ultra Cinematic Materials System

_createMaterials(){

this._materials.heart=new THREE.MeshPhysicalMaterial({
color:new THREE.Color(1.0,0.25,0.45),
emissive:new THREE.Color(1.0,0.05,0.25),
emissiveIntensity:2.8,
metalness:0.15,
roughness:0.25,
clearcoat:1.0,
clearcoatRoughness:0.15,
reflectivity:1.0,
ior:1.45,
transparent:false
})

this._materials.heartGlow=new THREE.MeshBasicMaterial({
color:new THREE.Color(1.0,0.2,0.5),
transparent:true,
opacity:0.35,
depthWrite:false,
blending:THREE.AdditiveBlending
})

this._materials.core=new THREE.MeshPhysicalMaterial({
color:new THREE.Color(1.0,0.1,0.35),
emissive:new THREE.Color(1.0,0.05,0.4),
emissiveIntensity:4.5,
metalness:0.35,
roughness:0.2,
clearcoat:1.0,
clearcoatRoughness:0.1,
reflectivity:1.0,
ior:1.6
})

this._materials.coreGlow=new THREE.MeshBasicMaterial({
color:new THREE.Color(1.0,0.1,0.6),
transparent:true,
opacity:0.4,
depthWrite:false,
blending:THREE.AdditiveBlending
})

this._materials.crystal=new THREE.MeshPhysicalMaterial({
color:new THREE.Color(0.6,0.2,1.0),
emissive:new THREE.Color(0.5,0.1,1.0),
emissiveIntensity:2.2,
metalness:0.25,
roughness:0.1,
transmission:0.35,
thickness:0.8,
transparent:true,
opacity:0.9,
ior:1.8
})

this._materials.ring=new THREE.MeshBasicMaterial({
color:new THREE.Color(1.0,0.2,0.8),
transparent:true,
opacity:0.65,
depthWrite:false,
blending:THREE.AdditiveBlending
})

}

_createEnergyCore(){

const coreMesh=new THREE.Mesh(
this._coreGeometry,
this._materials.core
)

coreMesh.position.set(0,0,0)

coreMesh.castShadow=true
coreMesh.receiveShadow=true

const glowMesh=new THREE.Mesh(
this._coreGeometry,
this._materials.coreGlow
)

glowMesh.scale.setScalar(1.35)

coreMesh.add(glowMesh)

coreMesh.userData={
rotationSpeed:0.35,
pulseOffset:Math.random()*Math.PI*2
}

this.group.add(coreMesh)

this.energyCores.push(coreMesh)

}
// ValentineObjects.js
// Part 3/6
// Ultra Cinematic Heart Objects System

_createHearts(){

for(let i=0;i<this._maxHearts;i++){

const heartMesh=new THREE.Mesh(
this._heartGeometry,
this._materials.heart
)

const glowMesh=new THREE.Mesh(
this._heartGeometry,
this._materials.heartGlow
)

const scale=THREE.MathUtils.randFloat(0.35,1.15)

heartMesh.scale.setScalar(scale)
glowMesh.scale.setScalar(scale*1.4)

heartMesh.add(glowMesh)

const radius=THREE.MathUtils.randFloat(4,this._bounds)

const theta=Math.random()*Math.PI*2
const phi=Math.random()*Math.PI

const x=radius*Math.sin(phi)*Math.cos(theta)
const y=THREE.MathUtils.randFloat(-6,6)
const z=radius*Math.sin(phi)*Math.sin(theta)

heartMesh.position.set(x,y,z)

heartMesh.rotation.set(
Math.random()*Math.PI,
Math.random()*Math.PI,
Math.random()*Math.PI
)

heartMesh.castShadow=true
heartMesh.receiveShadow=true

heartMesh.userData={

basePosition:heartMesh.position.clone(),

floatOffset:Math.random()*Math.PI*2,

floatSpeed:THREE.MathUtils.randFloat(0.4,1.2),

rotationSpeed:new THREE.Vector3(
THREE.MathUtils.randFloat(-0.4,0.4),
THREE.MathUtils.randFloat(-0.6,0.6),
THREE.MathUtils.randFloat(-0.4,0.4)
),

pulseOffset:Math.random()*Math.PI*2,

pulseSpeed:THREE.MathUtils.randFloat(1.0,2.5),

glowMesh:glowMesh

}

this.group.add(heartMesh)

this.hearts.push(heartMesh)

}

}
// ValentineObjects.js
// Part 4/6
// Ultra Cinematic Crystal and Energy Ring System

_createCrystals(){

for(let i=0;i<this._maxCrystals;i++){

const crystalMesh=new THREE.Mesh(
this._crystalGeometry,
this._materials.crystal
)

const scale=THREE.MathUtils.randFloat(0.4,1.4)

crystalMesh.scale.setScalar(scale)

const radius=THREE.MathUtils.randFloat(3,this._bounds)

const angle=Math.random()*Math.PI*2

const height=THREE.MathUtils.randFloat(-5,5)

crystalMesh.position.set(
Math.cos(angle)*radius,
height,
Math.sin(angle)*radius
)

crystalMesh.rotation.set(
Math.random()*Math.PI,
Math.random()*Math.PI,
Math.random()*Math.PI
)

crystalMesh.castShadow=true
crystalMesh.receiveShadow=true

crystalMesh.userData={

basePosition:crystalMesh.position.clone(),

floatOffset:Math.random()*Math.PI*2,

floatSpeed:THREE.MathUtils.randFloat(0.3,0.9),

rotationSpeed:new THREE.Vector3(
THREE.MathUtils.randFloat(-0.3,0.3),
THREE.MathUtils.randFloat(-0.5,0.5),
THREE.MathUtils.randFloat(-0.3,0.3)
),

pulseOffset:Math.random()*Math.PI*2,

pulseSpeed:THREE.MathUtils.randFloat(0.8,1.8)

}

this.group.add(crystalMesh)

this.crystals.push(crystalMesh)

}

}

_createEnergyRings(){

for(let i=0;i<this._maxRings;i++){

const ringMesh=new THREE.Mesh(
this._ringGeometry,
this._materials.ring
)

const scale=THREE.MathUtils.randFloat(0.8,2.2)

ringMesh.scale.setScalar(scale)

ringMesh.position.set(
0,
THREE.MathUtils.randFloat(-2.5,2.5),
0
)

ringMesh.rotation.set(
Math.random()*Math.PI,
Math.random()*Math.PI,
Math.random()*Math.PI
)

ringMesh.userData={

rotationSpeed:new THREE.Vector3(
THREE.MathUtils.randFloat(-0.25,0.25),
THREE.MathUtils.randFloat(-0.45,0.45),
THREE.MathUtils.randFloat(-0.25,0.25)
),

pulseOffset:Math.random()*Math.PI*2,

pulseSpeed:THREE.MathUtils.randFloat(0.6,1.6),

baseScale:scale

}

this.group.add(ringMesh)

this.rings.push(ringMesh)

}

}
// ValentineObjects.js
// Part 5/6
// Ultra Cinematic Animation System

update(delta){

if(!this._initialized)return

this._time+=delta

this._updateEnergyCore(delta)

this._updateHearts(delta)

this._updateCrystals(delta)

this._updateRings(delta)

}

_updateEnergyCore(delta){

for(let i=0;i<this.energyCores.length;i++){

const core=this.energyCores[i]

core.rotation.y+=delta*core.userData.rotationSpeed

const pulse=Math.sin(
this._time*2.2+
core.userData.pulseOffset
)*0.15+1.0

core.scale.setScalar(pulse)

}

}

_updateHearts(delta){

for(let i=0;i<this.hearts.length;i++){

const heart=this.hearts[i]

const data=heart.userData

const floatY=
Math.sin(
this._time*data.floatSpeed+
data.floatOffset
)*0.6

heart.position.y=
data.basePosition.y+
floatY

heart.rotation.x+=delta*data.rotationSpeed.x
heart.rotation.y+=delta*data.rotationSpeed.y
heart.rotation.z+=delta*data.rotationSpeed.z

const pulse=
Math.sin(
this._time*data.pulseSpeed+
data.pulseOffset
)*0.25+1.0

data.glowMesh.scale.setScalar(pulse*1.4)

}

}

_updateCrystals(delta){

for(let i=0;i<this.crystals.length;i++){

const crystal=this.crystals[i]

const data=crystal.userData

const floatY=
Math.sin(
this._time*data.floatSpeed+
data.floatOffset
)*0.4

crystal.position.y=
data.basePosition.y+
floatY

crystal.rotation.x+=delta*data.rotationSpeed.x
crystal.rotation.y+=delta*data.rotationSpeed.y
crystal.rotation.z+=delta*data.rotationSpeed.z

}

}

_updateRings(delta){

for(let i=0;i<this.rings.length;i++){

const ring=this.rings[i]

const data=ring.userData

ring.rotation.x+=delta*data.rotationSpeed.x
ring.rotation.y+=delta*data.rotationSpeed.y
ring.rotation.z+=delta*data.rotationSpeed.z

const pulse=
Math.sin(
this._time*data.pulseSpeed+
data.pulseOffset
)*0.25+1.0

ring.scale.setScalar(
data.baseScale*pulse
)

}

}
// ValentineObjects.js
// Part 6/6
// Cleanup, Dispose, and Export System

dispose(){

if(!this._initialized)return

this.scene.remove(this.group)

for(let i=0;i<this.hearts.length;i++){

const heart=this.hearts[i]

if(heart.userData.glowMesh){

heart.userData.glowMesh.geometry?.dispose()

}

heart.geometry?.dispose()

}

for(let i=0;i<this.crystals.length;i++){

const crystal=this.crystals[i]

crystal.geometry?.dispose()

}

for(let i=0;i<this.energyCores.length;i++){

const core=this.energyCores[i]

core.geometry?.dispose()

}

for(let i=0;i<this.rings.length;i++){

const ring=this.rings[i]

ring.geometry?.dispose()

}

this._heartGeometry?.dispose()
this._coreGeometry?.dispose()
this._crystalGeometry?.dispose()
this._ringGeometry?.dispose()

for(const key in this._materials){

this._materials[key]?.dispose()

}

this.hearts.length=0
this.crystals.length=0
this.energyCores.length=0
this.rings.length=0

this._initialized=false

}

}

export { ValentineObjects }
