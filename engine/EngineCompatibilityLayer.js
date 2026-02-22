class EngineCompatibilityLayer{

constructor(engine){

this.engine=engine

}

get scene(){

return this.engine.scene

}

get camera(){

return this.engine.camera

}

get renderer(){

return this.engine.renderer

}

onUpdate(fn){

this.engine.onUpdate(fn)

}

offUpdate(fn){

this.engine.offUpdate(fn)

}

start(){

this.engine.start()

}

}

export default EngineCompatibilityLayer
