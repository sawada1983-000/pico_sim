import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Tube, RoundedBox, Text, Instance, Instances } from '@react-three/drei';
import * as THREE from 'three';

// --- 1. Python実行エンジン (マルチピン対応) ---
function usePythonEngine() {
  // 変更点: 単一の boolean ではなく、ピン番号ごとの状態を管理するオブジェクトにする
  // 例: { 25: true, 15: false }
  const [pinStates, setPinStates] = useState({});
  const [ready, setReady] = useState(false);
  const [logs, setLogs] = useState([]);
  const pyodideRef = useRef(null);

  useEffect(() => {
    const init = async () => {
      if (window.loadPyodide) {
        try {
          const py = await window.loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/" });
          pyodideRef.current = py;
          
          // Pythonから呼ばれる関数：ピン番号と状態を受け取る
          window.picoPinUpdate = (pin, state) => {
            setPinStates(prev => ({ ...prev, [pin]: state }));
          };
          
          window.picoLog = (msg) => setLogs(prev => [...prev, "> " + msg]);
          py.setStdout({ batched: (msg) => setLogs(prev => [...prev, msg]) });
          setReady(true);
        } catch (e) { console.error(e); }
      }
    };
    init();
  }, []);

  const run = async (inputCode) => {
    if (!pyodideRef.current) return;
    setPinStates({}); // 実行時に状態リセット
    setLogs([">>> 実行開始"]);
    let transformedCode = inputCode.replace(/time\.sleep\(/g, "await asyncio.sleep(");
    const header = "import asyncio\nimport time\n"; 
    
    // Python側の Pin クラスを更新
    const shim = `
import js
class Pin:
    OUT = "OUT"
    IN = "IN"
    def __init__(self, pin, mode=OUT): 
        self.pin = pin
        self.mode = mode
    def value(self, val):
        # ピン番号と値をJSに送る
        js.window.picoPinUpdate(self.pin, val == 1)
def print(*args):
    msg = " ".join(map(str, args))
    js.window.picoLog(msg)
`;
    try {
      await pyodideRef.current.runPythonAsync(shim + "\n" + header + transformedCode);
      setLogs(prev => [...prev, ">>> 実行終了"]);
    } catch (err) {
      setLogs(prev => [...prev, "Error: " + err.message]);
    }
  };

  const stop = () => {
    setPinStates({});
    setLogs(prev => [...prev, ">>> 停止 (リセット)"]);
  };

  return { pinStates, ready, logs, run, stop };
}


// --- 2. 座標計算 & ピンマッピングロジック ---
const PITCH = 0.254;
const ROW_COUNT = 30;
const GAP_CENTER = 0.762;
const GAP_POWER = 0.4;

function getHolePos(row, col) {
  const zOffset = -((ROW_COUNT - 1) * PITCH) / 2;
  const z = zOffset + (row - 1) * PITCH;
  let x = 0;
  if (col <= 5) x = -((GAP_CENTER / 2) + (5 - col) * PITCH);
  else x = (GAP_CENTER / 2) + (col - 6) * PITCH;
  return [x, 0.15, z];
}

// 行番号からPicoのGPIO番号を特定するマップ (PicoがRow 1から刺さっている前提)
// 左列: Row 1-20, 右列: Row 1-20
function getGpioFromRow(row, col) {
  // 左列 (Col <= 5)
  if (col <= 5) {
    const leftMap = { 1:0, 2:1, 4:2, 5:3, 6:4, 7:5, 9:6, 10:7, 11:8, 12:9, 14:10, 15:11, 16:12, 17:13, 19:14, 20:15 };
    return leftMap[row] !== undefined ? leftMap[row] : null;
  } 
  // 右列 (Col >= 6)
  else {
    const rightMap = { 20:16, 19:17, 17:18, 16:19, 15:20, 14:21, 12:22, 10:26, 9:27, 7:28 };
    return rightMap[row] !== undefined ? rightMap[row] : null;
  }
}


// --- 3. 3D部品 ---

function Electron({ path, speed = 0.5, offset = 0 }) {
  const meshRef = useRef();
  const progress = useRef(offset);
  useFrame((state, delta) => {
    if (!meshRef.current) return;
    progress.current += speed * delta;
    if (progress.current > 1) progress.current -= 1;
    meshRef.current.position.copy(path.getPointAt(progress.current));
  });
  return <mesh ref={meshRef}><sphereGeometry args={[0.025]} /><meshBasicMaterial color="#ffff00" toneMapped={false}/></mesh>;
}

function CleanWire({ startRow, startCol, endRow, endCol, color, level = 1, isActive }) {
  const start = getHolePos(startRow, startCol);
  const end = getHolePos(endRow, endCol);
  const path = useMemo(() => {
    const pStart = new THREE.Vector3(...start);
    const pEnd = new THREE.Vector3(...end);
    pStart.y += 0.15; pEnd.y += 0.15;
    const lift = 0.5 + (level * 0.2);
    const points = [pStart, new THREE.Vector3(pStart.x, lift, pStart.z), new THREE.Vector3(pEnd.x, lift, pEnd.z), pEnd];
    return new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.1);
  }, [start, end, level]);

  return (
    <group>
      <Tube args={[path, 64, 0.045, 8, false]}>
        <meshPhysicalMaterial color={color} transparent opacity={0.4} roughness={0.2} metalness={0.1} />
      </Tube>
      <mesh position={[start[0],0.1,start[2]]}><cylinderGeometry args={[0.025,0.025,0.4]}/><meshStandardMaterial color="#ccc"/></mesh>
      <mesh position={[end[0],0.1,end[2]]}><cylinderGeometry args={[0.025,0.025,0.4]}/><meshStandardMaterial color="#ccc"/></mesh>
      {isActive && [0,0.2,0.4,0.6,0.8].map(i => <Electron key={i} path={path} offset={i}/>)}
    </group>
  );
}

function LEDComponent({ row, col, isActive }) {
  const [x, , z] = getHolePos(row, col);
  return (
    <mesh position={[x, 0.2, z]}>
      <sphereGeometry args={[0.2]} />
      <meshStandardMaterial color={isActive ? "red" : "#500"} emissive={isActive ? "red" : "black"} emissiveIntensity={isActive ? 1 : 0} />
      <mesh position={[0, -0.1, 0]}><cylinderGeometry args={[0.02, 0.02, 0.2]} /><meshStandardMaterial color="silver" /></mesh>
    </mesh>
  );
}

function ResistorComponent({ row, col, scale = 1.0 }) {
  const [x, , z] = getHolePos(row, col);
  return (
    <group position={[x, 0.25 * scale, z]} rotation={[0, 0, Math.PI / 2]} scale={[scale, scale, scale]}>
      <mesh><cylinderGeometry args={[0.12, 0.12, 0.6]} /><meshStandardMaterial color="#e0c0a0" /></mesh>
      <mesh position={[0, 0.15, 0]}><cylinderGeometry args={[0.125, 0.125, 0.05]} /><meshStandardMaterial color="brown" /></mesh>
      <mesh position={[0, 0.05, 0]}><cylinderGeometry args={[0.125, 0.125, 0.05]} /><meshStandardMaterial color="black" /></mesh>
      <mesh position={[0, -0.05, 0]}><cylinderGeometry args={[0.125, 0.125, 0.05]} /><meshStandardMaterial color="red" /></mesh>
      <mesh position={[0, -0.2, 0]}><cylinderGeometry args={[0.125, 0.125, 0.05]} /><meshStandardMaterial color="gold" metalness={0.8} /></mesh>
      <mesh position={[0, 0.45, 0]}><cylinderGeometry args={[0.03, 0.03, 0.3]} /><meshStandardMaterial color="silver" /></mesh>
      <mesh position={[0, -0.45, 0]}><cylinderGeometry args={[0.03, 0.03, 0.3]} /><meshStandardMaterial color="silver" /></mesh>
    </group>
  );
}

function Breadboard({ onHoleClick, selectedHole }) {
  const holes = useMemo(() => {
    const temp = [];
    for (let r=1; r<=ROW_COUNT; r++) {
      for (let c=1; c<=10; c++) temp.push({pos: getHolePos(r,c), r, c});
    }
    return temp;
  }, []);

  return (
    <group position={[0, -0.15, 0]}>
      <RoundedBox args={[5.5, 0.3, ROW_COUNT*PITCH+0.5]} radius={0.1}><meshStandardMaterial color="#fff"/></RoundedBox>
      <Instances range={holes.length}>
        <boxGeometry args={[0.12, 0.1, 0.12]} />
        <meshStandardMaterial color="#111" />
        {holes.map((h, i) => (
          <Instance 
            key={i} 
            position={[h.pos[0], 0.15, h.pos[2]]} 
            onClick={(e) => { e.stopPropagation(); onHoleClick(h.r, h.c); }}
          />
        ))}
      </Instances>
      {selectedHole && (
        <mesh position={[getHolePos(selectedHole.row, selectedHole.col)[0], 0.16, getHolePos(selectedHole.row, selectedHole.col)[2]]} rotation={[-Math.PI/2, 0, 0]}>
          <ringGeometry args={[0.08, 0.12, 32]} />
          <meshBasicMaterial color="yellow" side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

function Pico({ pinStates }) {
  const [, yRef, zRef] = getHolePos(1, 3);
  // Pico本体のLED (GP25)
  const isInternalLedOn = pinStates[25];

  const leftPins = [
    { name: "GP0", color: "#fff" }, { name: "GP1", color: "#fff" }, { name: "GND", color: "#000", bg: "#ccc" }, { name: "GP2", color: "#fff" }, { name: "GP3", color: "#fff" },
    { name: "GP4", color: "#fff" }, { name: "GP5", color: "#fff" }, { name: "GND", color: "#000", bg: "#ccc" }, { name: "GP6", color: "#fff" }, { name: "GP7", color: "#fff" },
    { name: "GP8", color: "#fff" }, { name: "GP9", color: "#fff" }, { name: "GND", color: "#000", bg: "#ccc" }, { name: "GP10", color: "#fff" }, { name: "GP11", color: "#fff" },
    { name: "GP12", color: "#fff" }, { name: "GP13", color: "#fff" }, { name: "GND", color: "#000", bg: "#ccc" }, { name: "GP14", color: "#fff" }, { name: "GP15", color: "#fff" }
  ];
  const rightPins = [
    { name: "VBUS", color: "#ffcccc" }, { name: "VSYS", color: "#ffcccc" }, { name: "GND", color: "#000", bg: "#ccc" }, { name: "3V3_EN", color: "#ffcccc" }, { name: "3V3", color: "#ffcccc" },
    { name: "ADC_REF", color: "#ffcccc" }, { name: "GP28", color: "#fff" }, { name: "GND", color: "#000", bg: "#ccc" }, { name: "GP27", color: "#fff" }, { name: "GP26", color: "#fff" },
    { name: "RUN", color: "#ffcccc" }, { name: "GP22", color: "#fff" }, { name: "GND", color: "#000", bg: "#ccc" }, { name: "GP21", color: "#fff" }, { name: "GP20", color: "#fff" },
    { name: "GP19", color: "#fff" }, { name: "GP18", color: "#fff" }, { name: "GND", color: "#000", bg: "#ccc" }, { name: "GP17", color: "#fff" }, { name: "GP16", color: "#fff" }
  ];

  return (
    <group position={[0, yRef+0.05, zRef+(19*PITCH)/2]}>
      <RoundedBox args={[2.1, 0.08, 5.2]} radius={0.05}><meshStandardMaterial color="#006600"/></RoundedBox>
      <mesh position={[0, 0.15, -2.4]}><boxGeometry args={[0.8, 0.25, 0.6]} /><meshStandardMaterial color="silver" /></mesh>
      <Text position={[0, 0.1, 0]} rotation={[-Math.PI/2, 0, 0]} fontSize={0.4}>RPi Pico</Text>
      
      {/* 内部LED (GP25) の表示 */}
      <mesh position={[-0.4, 0.1, -1.8]}>
        <boxGeometry args={[0.2, 0.05, 0.2]} />
        <meshStandardMaterial 
          color={isInternalLedOn ? "#00ff00" : "#003300"} 
          emissive={isInternalLedOn ? "#00ff00" : "#000"} 
        />
      </mesh>
      <Text position={[-0.4, 0.11, -1.5]} rotation={[-Math.PI/2, 0, 0]} fontSize={0.15} color="white">LED</Text>

      {Array.from({ length: 20 }).map((_, i) => (
        <React.Fragment key={i}>
          <group position={[-0.889, -0.15, -2.413 + i * PITCH]}>
            <cylinderGeometry args={[0.03, 0.03, 0.4]} /><meshStandardMaterial color="gold" />
            <Text position={[-0.5, 0.21, 0]} rotation={[-Math.PI/2, 0, 0]} fontSize={0.12} color={leftPins[i].color} anchorX="right" outlineWidth={0.01} outlineColor="#003300">{leftPins[i].name}</Text>
          </group>
          <group position={[0.889, -0.15, -2.413 + i * PITCH]}>
            <cylinderGeometry args={[0.03, 0.03, 0.4]} /><meshStandardMaterial color="gold" />
            <Text position={[0.5, 0.21, 0]} rotation={[-Math.PI/2, 0, 0]} fontSize={0.12} color={rightPins[i].color} anchorX="left" outlineWidth={0.01} outlineColor="#003300">{rightPins[i].name}</Text>
          </group>
        </React.Fragment>
      ))}
    </group>
  );
}


// --- 4. メインアプリUI ---

export default function App() {
  const { pinStates, ready, logs, run, stop } = usePythonEngine();
  
  const [wires, setWires] = useState([
    // 例: GP15(Row 20)から Row 25へ
    { id: 1, sR: 20, sC: 5, eR: 25, eC: 5, color: 'green', level: 2 },
    { id: 2, sR: 25, sC: 6, eR: 3, eC: 10, color: 'black', level: 1 },
  ]);
  const [leds, setLeds] = useState([{ id: 1, row: 25, col: 9 }]);
  const [resistors, setResistors] = useState([{ id: 1, row: 25, col: 8, scale: 1.0 }]);

  const [selectedHole, setSelectedHole] = useState(null);
  const [inputWire, setInputWire] = useState({ sR: 1, sC: 1, eR: 1, eC: 1, color: 'blue' });
  const [inputLed, setInputLed] = useState({ row: 1, col: 1 });
  const [inputResistor, setInputResistor] = useState({ row: 1, col: 1, scale: 1.0 });
  
  const [code, setCode] = useState(`import time
led = Pin(25, Pin.OUT)
test = Pin(15, Pin.OUT)

print("Start")
for i in range(5):
    test.value(1) # Pin 15だけ光るはず！
    time.sleep(0.5)
    test.value(0)
    time.sleep(0.5)
print("Done")`);

  const addWire = () => {
    setWires([...wires, { ...inputWire, id: Date.now(), sR: Number(inputWire.sR), sC: Number(inputWire.sC), eR: Number(inputWire.eR), eC: Number(inputWire.eC), level: 2 }]);
  };
  const addLed = () => setLeds([...leds, { id: Date.now(), row: Number(inputLed.row), col: Number(inputLed.col) }]);
  const addResistor = () => setResistors([...resistors, { ...inputResistor, id: Date.now(), row: Number(inputResistor.row), col: Number(inputResistor.col), scale: Number(inputResistor.scale) }]);
  
  const removeWire = (id) => setWires(wires.filter(w => w.id !== id));
  const removeLed = (id) => setLeds(leds.filter(l => l.id !== id));
  const removeResistor = (id) => setResistors(resistors.filter(r => r.id !== id));

  const handleHoleClick = (row, col) => setSelectedHole({ row, col });
  const setFromSelection = (type, field) => {
    if (!selectedHole) return;
    if (type === 'wire') setInputWire(prev => ({ ...prev, [field + 'R']: selectedHole.row, [field + 'C']: selectedHole.col }));
    else if (type === 'led') setInputLed({ row: selectedHole.row, col: selectedHole.col });
    else if (type === 'resistor') setInputResistor(prev => ({ ...prev, row: selectedHole.row, col: selectedHole.col }));
  };

  // ★重要: そのワイヤーやLEDが光るべきかどうかを判定する関数
  const isComponentActive = (row1, col1, row2 = null, col2 = null) => {
    // 接続されている穴がGPIOピンかチェックする
    const pin1 = getGpioFromRow(row1, col1);
    const pin2 = (row2 && col2) ? getGpioFromRow(row2, col2) : null;
    
    // どちらかの穴がONになっているピンなら光らせる
    if (pin1 !== null && pinStates[pin1]) return true;
    if (pin2 !== null && pinStates[pin2]) return true;
    
    // (応用: ワイヤー同士の連鎖はまだ未実装。直接Picoに刺さっているものだけ反応します)
    return false;
  };

  return (
    <div style={{ height: '100vh', display: 'flex' }}>
      
      {/* 左パネル (500px) */}
      <div style={{ width: '500px', display: 'flex', flexDirection: 'column', borderRight: '1px solid #444', background: '#1e1e1e', color: '#fff' }}>
        <div style={{ padding: '10px', background: '#007acc', fontWeight: 'bold' }}>
          Selected: {selectedHole ? `Row ${selectedHole.row}, Col ${selectedHole.col}` : "(Click a hole)"}
        </div>

        <div style={{ padding: '10px', background: '#252526', display: 'flex', gap: '10px' }}>
          <button onClick={() => run(code)} disabled={!ready} style={{ background: 'green', color: 'white', padding: '8px 20px', border:'none', cursor:'pointer', fontWeight:'bold', borderRadius:'4px' }}>▶ Run</button>
          <button onClick={stop} style={{ background: 'red', color: 'white', padding: '8px 20px', border:'none', cursor:'pointer', fontWeight:'bold', borderRadius:'4px' }}>■ Stop</button>
        </div>

        <textarea value={code} onChange={(e) => setCode(e.target.value)} spellCheck="false" style={{ height: '300px', background: '#111', color: '#eee', border: 'none', padding: '15px', resize: 'vertical', fontFamily: 'Consolas, monospace', fontSize: '14px', lineHeight: '1.5', outline: 'none' }} />
        <div style={{ height: '100px', background: '#000', padding: '10px', fontSize: '12px', overflowY: 'auto', fontFamily: 'monospace', borderTop: '1px solid #444' }}>{logs.map((l, i) => <div key={i}>{l}</div>)}</div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {/* Wire Builder */}
          <div style={{ padding: '15px', borderTop: '1px solid #444' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '8px', color:'#4ec9b0' }}>⚡ Jumper Wires</div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom:'5px' }}>
              <span style={{width:'40px', fontSize:'12px'}}>Start:</span>
              <input type="number" value={inputWire.sR} onChange={e=>setInputWire({...inputWire, sR:e.target.value})} style={{width:'40px', marginRight:'5px', padding:'4px'}}/>
              <input type="number" value={inputWire.sC} onChange={e=>setInputWire({...inputWire, sC:e.target.value})} style={{width:'40px', marginRight:'5px', padding:'4px'}}/>
              <button onClick={() => setFromSelection('wire', 's')} style={{fontSize:'11px', cursor:'pointer', padding:'2px 8px'}}>Set</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom:'8px' }}>
              <span style={{width:'40px', fontSize:'12px'}}>End:</span>
              <input type="number" value={inputWire.eR} onChange={e=>setInputWire({...inputWire, eR:e.target.value})} style={{width:'40px', marginRight:'5px', padding:'4px'}}/>
              <input type="number" value={inputWire.eC} onChange={e=>setInputWire({...inputWire, eC:e.target.value})} style={{width:'40px', marginRight:'5px', padding:'4px'}}/>
              <button onClick={() => setFromSelection('wire', 'e')} style={{fontSize:'11px', cursor:'pointer', padding:'2px 8px'}}>Set</button>
            </div>
            <div style={{display:'flex', gap:'5px'}}>
              <select value={inputWire.color} onChange={e=>setInputWire({...inputWire, color:e.target.value})} style={{flex:1, padding:'4px'}}>
                <option value="green">Green</option><option value="black">Black</option><option value="red">Red</option><option value="blue">Blue</option><option value="yellow">Yellow</option>
              </select>
              <button onClick={addWire} style={{padding:'4px 12px', cursor:'pointer'}}>Add Wire</button>
            </div>
            <div style={{ marginTop: '8px', fontSize: '11px', maxHeight: '100px', overflowY: 'auto', background:'#222', padding:'5px', borderRadius:'4px' }}>
              {wires.map(w => (<div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom:'2px' }}><span>{w.color}: {w.sR},{w.sC} → {w.eR},{w.eC}</span><button onClick={() => removeWire(w.id)} style={{color:'red', background:'none', border:'none', cursor:'pointer'}}>x</button></div>))}
            </div>
          </div>

          {/* LED Builder */}
          <div style={{ padding: '15px', borderTop: '1px solid #444' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '8px', color:'#ce9178' }}>💡 LEDs</div>
            <div style={{ display: 'flex', gap: '5px', marginBottom: '5px', alignItems:'center' }}>
              <input type="number" value={inputLed.row} onChange={e=>setInputLed({...inputLed, row:e.target.value})} style={{width:'40px', padding:'4px'}} placeholder="R"/>
              <input type="number" value={inputLed.col} onChange={e=>setInputLed({...inputLed, col:e.target.value})} style={{width:'40px', padding:'4px'}} placeholder="C"/>
              <button onClick={() => setFromSelection('led')} style={{fontSize:'11px', cursor:'pointer', padding:'4px 8px'}}>Set</button>
              <button onClick={addLed} style={{padding:'4px 12px', cursor:'pointer'}}>Add</button>
            </div>
            <div style={{ fontSize: '11px', maxHeight: '80px', overflowY: 'auto', background:'#222', padding:'5px', borderRadius:'4px' }}>
              {leds.map(l => (<div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom:'2px' }}><span>LED: {l.row}, {l.col}</span><button onClick={() => removeLed(l.id)} style={{color:'red', background:'none', border:'none', cursor:'pointer'}}>x</button></div>))}
            </div>
          </div>

          {/* Resistor Builder */}
          <div style={{ padding: '15px', borderTop: '1px solid #444' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '8px', color:'#dcdcaa' }}>📏 Resistors</div>
            <div style={{ display: 'flex', gap: '5px', marginBottom: '5px', alignItems: 'center' }}>
              <input type="number" value={inputResistor.row} onChange={e=>setInputResistor({...inputResistor, row:e.target.value})} style={{width:'40px', padding:'4px'}} placeholder="R"/>
              <input type="number" value={inputResistor.col} onChange={e=>setInputResistor({...inputResistor, col:e.target.value})} style={{width:'40px', padding:'4px'}} placeholder="C"/>
              <span style={{fontSize:'12px'}}>Size:</span>
              <input type="number" step="0.1" value={inputResistor.scale} onChange={e=>setInputResistor({...inputResistor, scale:e.target.value})} style={{width:'40px', padding:'4px'}}/>
              <button onClick={() => setFromSelection('resistor')} style={{fontSize:'11px', cursor:'pointer', padding:'4px 8px'}}>Set</button>
              <button onClick={addResistor} style={{padding:'4px 12px', cursor:'pointer'}}>Add</button>
            </div>
            <div style={{ fontSize: '11px', maxHeight: '80px', overflowY: 'auto', background:'#222', padding:'5px', borderRadius:'4px' }}>
              {resistors.map(r => (<div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom:'2px' }}><span>Res: {r.row}, {r.col} (x{r.scale})</span><button onClick={() => removeResistor(r.id)} style={{color:'red', background:'none', border:'none', cursor:'pointer'}}>x</button></div>))}
            </div>
          </div>
        </div>
      </div>

      {/* 右パネル (3D) */}
      <div style={{ flex: 1, background: '#111' }}>
        <Canvas camera={{ position: [5, 12, 5], fov: 45 }}>
          <color attach="background" args={['#222']} />
          <ambientLight intensity={0.6} />
          <directionalLight position={[5, 10, 5]} intensity={1} />
          <OrbitControls makeDefault target={[0, 0, 0]} />
          <Breadboard onHoleClick={handleHoleClick} selectedHole={selectedHole} />
          
          {/* Picoにピンの状態を渡して、内部LEDを光らせる */}
          <Pico pinStates={pinStates} />

          {wires.map(w => (
            <CleanWire 
              key={w.id} 
              startRow={w.sR} startCol={w.sC} endRow={w.eR} endCol={w.eC} 
              color={w.color} level={w.level} 
              // そのワイヤーが接続されているピンがONのときだけ電流を流す
              isActive={isComponentActive(w.sR, w.sC, w.eR, w.eC)} 
            />
          ))}
          {leds.map(l => (
            <LEDComponent 
              key={l.id} row={l.row} col={l.col} 
              // そのLEDが接続されているピンがONのときだけ光る
              isActive={isComponentActive(l.row, l.col)} 
            />
          ))}
          {resistors.map(r => <ResistorComponent key={r.id} row={r.row} col={r.col} scale={r.scale} />)}
        </Canvas>
      </div>
    </div>
  );
}