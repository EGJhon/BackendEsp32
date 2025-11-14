import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pool from "./db.js"; // conexión a PostgreSQL
import mqtt from "mqtt";
import admin from "firebase-admin"; // <-- NUEVO
// --- NUEVA BIBLIOTECA DE IA ---
import { RandomForestRegression } from 'ml-random-forest';
// --- Inicio del bloque de reemplazo ---
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serviceAccount = JSON.parse(fs.readFileSync(join(__dirname, 'serviceAccountKey.json'), 'utf8'));
// --- Fin del bloque de reemplazo ---

const app = express();
const PORT = process.env.PORT || 3000;

// ===================================
// CONSTANTE DE ADMINISTRADOR
// ===================================
const ADMIN_EMAIL = "jegdota@gmail.com"; // <--- ¡CAMBIA ESTO!

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// ===================================
// INICIALIZACIÓN DE FIREBASE ADMIN
// ===================================
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// ===================================
// MIDDLEWARE DE SEGURIDAD (PARTE 1)
// ===================================

// 1. Middleware para "Verificar Token" (Cualquier usuario logueado)
const checkAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  
  if (!token) {
    return res.status(401).send('No autorizado: Sin token');
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken; // Añadimos el usuario a la solicitud
    next();
  } catch (error) {
    console.error("Error verificando token:", error);
    res.status(401).send('No autorizado: Token inválido');
  }
};

// 2. Middleware para "Verificar si es Admin" (Solo el admin)
const isAdmin = (req, res, next) => {
  if (req.user.email === ADMIN_EMAIL) {
    next(); // El usuario es admin, continuar
  } else {
    // El usuario está logueado, pero NO es admin
    res.status(403).send('Prohibido: Requiere permisos de administrador');
  }
};

// ===================================
// FUNCIÓN DE PRONÓSTICO (¡NUEVA EN BACKEND!)
// ===================================
async function getWeatherForecast() {
  const lat = -12.04;
  const lon = -77.02;

  if (OWM_API_KEY === "TU_API_KEY_GRATUITA_VA_AQUI") {
    console.error("Error: Falta la API Key de OpenWeatherMap en el backend.");
    return null;
  }
  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${OWM_API_KEY}&units=metric`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Error de OpenWeatherMap: ${errorData.message}`);
    }
    const data = await response.json();
    const first24Hours = data.list.slice(0, 8);
    if (!first24Hours || first24Hours.length === 0) {
      throw new Error("OWM no devolvió datos en la 'list'.");
    }
    const hourlyMaxTemps = first24Hours.map(forecast => forecast.main.temp_max);
    const maxTemp = Math.max(...hourlyMaxTemps);
    console.log(`(Backend) Pronóstico OWM T° Máx: ${maxTemp}°C`);
    return maxTemp;
  } catch (err) {
    console.error("Error al obtener el pronóstico del tiempo (Backend):", err);
    return null;
  }
}


// ===================================
// LÓGICA DE MQTT (¡¡MODIFICADA!!)
// ===================================
const MQTT_BROKER = "762358bc25e4449fb40ac5b6645ff3dc.s1.eu.hivemq.cloud";
const MQTT_PORT = 8883;
const MQTT_USER = "JhonE";
const MQTT_PASSWORD = "192837465Jhon";
const MQTT_TOPIC_DATOS = "sensores/planta/datos"; // ESP32 publica aquí
const MQTT_TOPIC_COMANDOS = "planta/comandos";   // ESP32 escucha aquí

const mqttOptions = { 
  host: MQTT_BROKER,
  port: MQTT_PORT,
  protocol: 'mqtts',
  username: MQTT_USER,
  password: MQTT_PASSWORD
};
const client = mqtt.connect(mqttOptions);

client.on('connect', () => {
  console.log('✅ Conectado exitosamente al Broker MQTT');
  // El backend ahora SÓLO escucha el topic de datos
  client.subscribe(MQTT_TOPIC_DATOS, (err) => {
    if (!err) {
      console.log(`👂 Suscrito al topic: ${MQTT_TOPIC_DATOS}`);
    } else {
      console.error('Error al suscribirse:', err);
    }
  });
});

// ¡¡ESTA ES LA LÓGICA PRINCIPAL!!
client.on('message', async (topic, payload) => { 
  const messageString = payload.toString();
  console.log(`[MQTT] Mensaje recibido en ${topic}: ${messageString}`);
  
  let datos;
  try {
    datos = JSON.parse(messageString);
  } catch (error) {
    console.error("[MQTT] Error: Mensaje JSON malformado:", messageString);
    return; // Salir si el JSON es inválido
  }

  const { planta_id, temperatura, humedad, nivel_agua, agua_consumida } = datos;

  // --- 1. Guardar en la Base de Datos (Lógica existente) ---
  if (planta_id && temperatura !== undefined && humedad !== undefined) {
    try {
      const query = `
        INSERT INTO lecturas (planta_id, temperatura, humedad, nivel_agua, agua_consumida, fecha)
        VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING *;
      `;
      const values = [planta_id, temperatura, humedad, nivel_agua || null, agua_consumida || null];
      const result = await pool.query(query, values);
      console.log('[MQTT] Datos guardados en la BD:', result.rows[0]);
    } catch (error) {
      console.error("[MQTT] Error al guardar en BD:", error);
    }
  } else {
    console.warn("[MQTT] Mensaje recibido sin datos completos para guardar en BD.");
  }


  // --- 2. Lógica de Decisión de IA (¡NUEVO!) ---
  // Asegurarse de que el modelo y los datos básicos están listos
  if (!iaModel || !iaStats || !planta_id || temperatura === undefined || humedad === undefined) {
    console.log("[IA] Omitiendo decisión: Faltan datos (planta_id, temp, hum) o el modelo no está listo.");
    return;
  }

  try {
    // A. OBTENER UMBRALES
    const queryUmbrales = `
      SELECT T.temp_min, T.temp_max, T.hum_min, T.hum_max
      FROM tipo_planta T
      JOIN plantas P ON T.id = P.id_tipo
      WHERE P.id = $1;
    `;
    const umbralesResult = await pool.query(queryUmbrales, [planta_id]);
    if (umbralesResult.rows.length === 0) {
      console.error(`[IA] No se encontraron umbrales para planta_id: ${planta_id}`);
      return;
    }
    const umbrales = umbralesResult.rows[0];

    // B. OBTENER PRONÓSTICO DEL TIEMPO
    const forecastedMaxTemp = await getWeatherForecast(); // Usar la función que añadimos
    if (forecastedMaxTemp === null) {
      console.error("[IA] No se pudo obtener el pronóstico del tiempo.");
      return;
    }

    // C. PREPARAR DATOS PARA LA IA (Las 9 variables)
    const rawInput = [
      parseFloat(temperatura),
      parseFloat(humedad),
      Math.sin(2 * Math.PI * new Date().getHours() / 23.0),
      Math.cos(2 * Math.PI * new Date().getHours() / 23.0),
      parseFloat(umbrales.temp_min),
      parseFloat(umbrales.temp_max),
      parseFloat(umbrales.hum_min),
      parseFloat(umbrales.hum_max),
      parseFloat(forecastedMaxTemp)
    ];

    // D. EJECUTAR PREDICCIÓN
    const { IA_MEAN, IA_STD } = iaStats;
    const normalizedInput = rawInput.map((val, i) => {
        if (IA_STD[i] === 0 || isNaN(IA_STD[i])) return val - IA_MEAN[i];
        return (val - IA_MEAN[i]) / IA_STD[i];
    });
    const prediction = iaModel.predict([normalizedInput]);
    const humedadFutura = prediction[0];

    // E. TOMAR LA DECISIÓN
    let decisionFinal = "ESPERAR";
    if (humedadFutura < parseFloat(umbrales.hum_min)) {
      decisionFinal = "REGAR_EXTRA";
    }

    // F. PUBLICAR COMANDO DE VUELTA AL ESP32
    if (decisionFinal === "REGAR_EXTRA") {
      // Publicamos en un topic específico para esa planta
      const commandTopic = `${MQTT_TOPIC_COMANDOS}/${planta_id}`;
      const commandMessage = "REGAR"; // Mensaje simple
      
      client.publish(commandTopic, commandMessage, (err) => {
        if (err) {
          console.error(`[MQTT] Error al publicar comando en ${commandTopic}:`, err);
        } else {
          console.log(`[IA] ¡Orden ${commandMessage} enviada a ${commandTopic}! (Futuro: ${humedadFutura.toFixed(1)}%)`);
        }
      });
    } else {
        console.log(`[IA] Decisión para ${planta_id}: ESPERAR (Futuro: ${humedadFutura.toFixed(1)}%)`);
    }

  } catch (error) {
    console.error(`[IA] Error fatal en la lógica de decisión para ${planta_id}:`, error.message);
  }
});

client.on('error', (err) => { console.error('Error de MQTT:', err); });
client.on('reconnect', () => { console.log('Reconectando al Broker MQTT...'); });

// ===================================
// RUTAS PÚBLICAS (No requieren login)
// ===================================
app.get("/", (req, res) => {
  res.send("🌱 API Sensores funcionando...");
});

// Obtener lista de tipos de planta para el combobox
app.get("/api/tipos-planta", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM tipo_planta ORDER BY nombre");
    res.json(result.rows);
  } catch (error) {
    console.error("Error en GET /api/tipos-planta:", error);
    res.status(500).json({ error: "Error en la consulta" });
  }
});

// Crear una planta (requiere login, así que lo ponemos en el router protegido)
// app.post("/api/plantas", ...) // La moveremos

// ===================================
// RUTAS PROTEGIDAS (Requieren Login)
// ===================================
const userRouter = express.Router();
userRouter.use(checkAuth); // <-- ¡Todas estas rutas requieren un token válido!

// Listar plantas de un usuario
userRouter.get("/plantas/:correo", async (req, res) => {
  // Aseguramos que el usuario solo pueda ver sus propias plantas
  if (req.user.email !== req.params.correo) {
    return res.status(403).send("Prohibido: No puedes ver las plantas de otro usuario");
  }
  
  try {
    const { correo } = req.params;
    const result = await pool.query(
      "SELECT * FROM plantas WHERE correo_usuario = $1 ORDER BY fecha_registro DESC",
      [correo]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error obteniendo plantas" });
  }
});

// Crear una planta
userRouter.post("/plantas", async (req, res) => {
  try {
    const { nombre, ubicacion, id_tipo } = req.body;
    const correo_usuario = req.user.email; // Obtenemos el email del token verificado

    if (!nombre || !id_tipo || !correo_usuario) {
      return res.status(400).json({ error: "Datos incompletos" });
    }
    const result = await pool.query(
      "INSERT INTO plantas (nombre, fecha_registro, ubicacion, id_tipo, correo_usuario) VALUES ($1, NOW(), $2, $3, $4) RETURNING *",
      [nombre, ubicacion || "", id_tipo, correo_usuario]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar planta" });
  }
});

// --- Rutas de Dashboard (Sensores y Reportes) ---
userRouter.get("/sensores/planta/:id", async (req, res) => { 
  try {
      const { id } = req.params;
      const result = await pool.query(
        "SELECT * FROM lecturas WHERE planta_id = $1 ORDER BY fecha DESC LIMIT 50",
        [id]
      );
      res.json(result.rows);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Error en la consulta por planta" });
    }
});
userRouter.get("/sensores/nivel-agua/:id", async (req, res) => { 
  try {
    const { id } = req.params;
    const result = await pool.query(
      "SELECT nivel_agua FROM lecturas WHERE planta_id = $1 ORDER BY fecha DESC LIMIT 1",
      [id]
    );

    if (result.rows.length === 0) {
      // No hay registros todavía
      return res.json({ nivel_agua: null, mensaje: "Aún no se ha recibido nivel de agua" });
    }

    res.json({ nivel_agua: result.rows[0].nivel_agua, mensaje: "Último nivel obtenido correctamente" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error en la consulta por nivel de agua" });
  } });
userRouter.get("/reporte/planta/:id", async (req, res) => { 
  try {
      const { id } = req.params;
  
      // 1. Reporte de 24 horas (Temp y Hum)
      const query24h = `
        SELECT
          AVG(temperatura) AS temp_avg,
          MAX(temperatura) AS temp_max,
          MIN(temperatura) AS temp_min,
          AVG(humedad) AS hum_avg,
          MAX(humedad) AS hum_max,
          MIN(humedad) AS hum_min
        FROM lecturas
        WHERE planta_id = $1 AND fecha >= NOW() - INTERVAL '24 hours'
      `;
      const res24h = await pool.query(query24h, [id]);
  
      // 2. Reporte de 7 días (Consumo de agua)
      const query7d = `
        SELECT
          SUM(agua_consumida) AS agua_total
        FROM lecturas
        WHERE planta_id = $1 AND fecha >= NOW() - INTERVAL '7 days'
      `;
      const res7d = await pool.query(query7d, [id]);
  
      // Combinamos los resultados en un solo objeto
      const reporte = {
        ...res24h.rows[0],
        ...res7d.rows[0]
      };
  
      res.json(reporte);
  
    } catch (error) {
      console.error("Error en GET /api/reporte/planta/:id", error);
      res.status(500).json({ error: "Error en el servidor al generar reporte" });
    }
});
userRouter.get("/planta/tipo/:id", async (req, res) => { 
  try {
      const { id } = req.params; // Este es el ID de la planta (de la tabla 'plantas')
  
      // Consulta SQL que une 'plantas' con 'tipo_planta'
      const query = `
        SELECT T.temp_min, T.temp_max, T.hum_min, T.hum_max
        FROM tipo_planta T
        JOIN plantas P ON T.id = P.id_tipo
        WHERE P.id = $1;
      `;
      
      const result = await pool.query(query, [id]);
  
      if (result.rows.length === 0) {
        // Si no encuentra, devuelve valores 'nulos' para no romper el frontend
        return res.json({ temp_min: null, temp_max: null, hum_min: null, hum_max: null });
      }
  
      res.json(result.rows[0]); // Devuelve { temp_min: 15, temp_max: 30, ... }
  
    } catch (error) {
      console.error("Error en GET /api/planta/tipo/:id", error);
      res.status(500).json({ error: "Error en el servidor" });
    }
});
userRouter.get("/reporte/eficiencia/:id", async (req, res) => { 
  try {
    const { id } = req.params;

    // Función helper para calcular el % en un rango de días
    const getEficiencia = async (intervalo) => {
      const query = `
        SELECT
          (COUNT(CASE WHEN T.ideal = 1 THEN 1 END) * 100.0 / (COUNT(*)+0.0001)) AS porcentaje
        FROM (
          SELECT
            CASE
              WHEN L.temperatura BETWEEN TP.temp_min AND TP.temp_max
               AND L.humedad BETWEEN TP.hum_min AND TP.hum_max
              THEN 1
              ELSE 0
            END AS ideal
          FROM lecturas L
          JOIN plantas P ON L.planta_id = P.id
          JOIN tipo_planta TP ON P.id_tipo = TP.id
          WHERE L.planta_id = $1 AND ${intervalo}
        ) T;
      `;
      const result = await pool.query(query, [id]);
      return parseFloat(result.rows[0].porcentaje || 0);
    };

    // 1. Calcular el porcentaje de la semana actual
    const porcentajeActual = await getEficiencia(
      "L.fecha >= NOW() - INTERVAL '7 days'"
    );

    // 2. Calcular el porcentaje de la semana anterior
    const porcentajeAnterior = await getEficiencia(
      "L.fecha >= NOW() - INTERVAL '14 days' AND L.fecha < NOW() - INTERVAL '7 days'"
    );
    
    // 3. Devolver ambos valores
    res.json({
      porcentaje_actual: porcentajeActual,
      porcentaje_anterior: porcentajeAnterior
    });

  } catch (error) {
    console.error("Error en GET /reporte/eficiencia/:id", error);
    res.status(500).json({ error: "Error en el servidor" });
  }
});
userRouter.get("/reporte/estres/:id", async (req, res) => { 
  try {
      const { id } = req.params;
      const query = `
        SELECT
          SUM(CASE WHEN L.temperatura > TP.temp_max THEN 1 ELSE 0 END) AS estres_calor,
          SUM(CASE WHEN L.temperatura < TP.temp_min THEN 1 ELSE 0 END) AS estres_frio,
          SUM(CASE WHEN L.humedad < TP.hum_min THEN 1 ELSE 0 END) AS estres_sequedad,
          SUM(CASE WHEN L.humedad > TP.hum_max THEN 1 ELSE 0 END) AS estres_exceso_agua
        FROM lecturas L
        JOIN plantas P ON L.planta_id = P.id
        JOIN tipo_planta TP ON P.id_tipo = TP.id
        WHERE L.planta_id = $1 AND L.fecha >= NOW() - INTERVAL '7 days';
      `;
      const result = await pool.query(query, [id]);
      res.json(result.rows[0]);
  
    } catch (error) {
      console.error("Error en GET /api/reporte/estres/:id", error);
      res.status(500).json({ error: "Error en el servidor" });
    }
});
userRouter.get("/reporte/agua/:id", async (req, res) => { 
  try {
      const { id } = req.params;
      const query = `
        SELECT
          SUM(consumo_diario) AS consumo_total_mes,
          AVG(consumo_diario) AS consumo_promedio_diario
        FROM (
          SELECT
            DATE(fecha) AS dia,
            SUM(agua_consumida) AS consumo_diario
          FROM lecturas
          WHERE planta_id = $1 AND fecha >= NOW() - INTERVAL '30 days'
          GROUP BY dia
        ) T;
      `;
      const result = await pool.query(query, [id]);
      res.json(result.rows[0]);
  
    } catch (error) {
      console.error("Error en GET /api/reporte/agua/:id", error);
      res.status(500).json({ error: "Error en el servidor" });
    }
 });
// (Añadimos aquí las rutas de sensores que faltaban)
userRouter.get("/sensores", async (req, res) => { 
  try {
      const result = await pool.query(
        "SELECT * FROM lecturas ORDER BY fecha DESC LIMIT 20"
      );
      res.json(result.rows);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Error en la consulta" });
    }
 });
userRouter.get("/sensores/ultimo", async (req, res) => { 
  try {
      const result = await pool.query(
        "SELECT * FROM lecturas ORDER BY fecha DESC LIMIT 1"
      );
      res.json(result.rows[0] || {});
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Error en la consulta" });
    }
 });


// ===================================
// RUTA DE PREDICCIÓN DE IA (NUEVO)
// ===================================
userRouter.post('/ia/predecir', async (req, res) => {
  // iaModel e iaStats se cargan más abajo
  if (!iaModel || !iaStats) { 
    return res.status(500).send({ error: 'Modelo no está listo' });
  }

  // 1. Recibir las 9 variables crudas
  const rawInput = req.body.input; // [temp, hum, sin, cos, ...]

  if (!rawInput || rawInput.length !== 9) {
    return res.status(400).send({ error: 'Se esperaban 9 valores en el array "input"' });
  }


  // 2. Normalizar (Usando los stats cargados)
  const { IA_MEAN, IA_STD } = iaStats;
  const normalizedInput = rawInput.map((val, i) => {
    // Evitar división por cero si la desviación es 0
    if (IA_STD[i] === 0 || isNaN(IA_STD[i])) return val - IA_MEAN[i];
    return (val - IA_MEAN[i]) / IA_STD[i];
  });

  // 3. Predecir
  const prediction = iaModel.predict([normalizedInput]);
  const humedadFutura = prediction[0];

  // 4. Devolver solo el resultado
  res.json({ prediccion: humedadFutura });
});



// Conectamos el router de usuario a la app
app.use('/api', userRouter);


// ===================================
// RUTAS DE ADMINISTRADOR (PARTE 2)
// ===================================
const adminRouter = express.Router();
// ¡¡PROTECCIÓN!! Solo un admin verificado puede usar estas rutas
adminRouter.use(checkAuth, isAdmin); 

// --- CRUD para TIPO_PLANTA ---
adminRouter.get('/tipo-planta', async (req, res) => {
  const result = await pool.query('SELECT * FROM tipo_planta ORDER BY id');
  res.json(result.rows);
});
adminRouter.post('/tipo-planta', async (req, res) => {
  const { nombre, temp_min, temp_max, hum_min, hum_max, descrip } = req.body;
  const result = await pool.query(
    'INSERT INTO tipo_planta (nombre, temp_min, temp_max, hum_min, hum_max, descrip) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [nombre, temp_min, temp_max, hum_min, hum_max, descrip || null]
  );
  res.status(201).json(result.rows[0]);
});
adminRouter.put('/tipo-planta/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, temp_min, temp_max, hum_min, hum_max, descrip } = req.body;
  const result = await pool.query(
    'UPDATE tipo_planta SET nombre=$1, temp_min=$2, temp_max=$3, hum_min=$4, hum_max=$5, descrip=$6 WHERE id=$7 RETURNING *',
    [nombre, temp_min, temp_max, hum_min, hum_max, descrip || null, id]
  );
  res.json(result.rows[0]);
});
adminRouter.delete('/tipo-planta/:id', async (req, res) => {
  const { id } = req.params;
  await pool.query('DELETE FROM tipo_planta WHERE id=$1', [id]);
  res.status(204).send();
});

// --- CRUD para PLANTAS ---
adminRouter.get('/plantas', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM plantas ORDER BY id');
    res.json(result.rows);
  } catch (error) {
    console.error("Error en GET /admin/plantas:", error);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

adminRouter.post('/plantas', async (req, res) => {
  try {
    const { nombre, ubicacion, id_tipo, correo_usuario } = req.body;
    if (!nombre || !id_tipo || !correo_usuario) {
      return res.status(400).json({ error: "Datos incompletos" });
    }
    const result = await pool.query(
      "INSERT INTO plantas (nombre, ubicacion, id_tipo, correo_usuario) VALUES ($1, $2, $3, $4) RETURNING *",
      [nombre, ubicacion || "", id_tipo, correo_usuario]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error en POST /admin/plantas:", error);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

adminRouter.put('/plantas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, ubicacion, id_tipo, correo_usuario } = req.body;
    if (!nombre || !id_tipo || !correo_usuario) {
      return res.status(400).json({ error: "Datos incompletos" });
    }
    const result = await pool.query(
      "UPDATE plantas SET nombre=$1, ubicacion=$2, id_tipo=$3, correo_usuario=$4 WHERE id=$5 RETURNING *",
      [nombre, ubicacion || "", id_tipo, correo_usuario, id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error en PUT /admin/plantas/:id", error);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

adminRouter.delete('/plantas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // ¡IMPORTANTE! Borrar primero las lecturas asociadas
    // para evitar un error de Foreign Key.
    await pool.query('DELETE FROM lecturas WHERE planta_id=$1', [id]);
    
    // Ahora sí, borrar la planta
    await pool.query('DELETE FROM plantas WHERE id=$1', [id]);
    
    res.status(204).send(); // Éxito, sin contenido
  } catch (error) {
    console.error("Error en DELETE /admin/plantas/:id", error);
    res.status(500).json({ error: "Error en el servidor" });
  }
});
// (Puedes añadir PUT, POST, DELETE para la tabla plantas aquí)

// --- CRUD para LECTURAS ---
adminRouter.get('/lecturas', async (req, res) => {
  const result = await pool.query('SELECT * FROM lecturas ORDER BY fecha DESC LIMIT 100');
  res.json(result.rows);
});
adminRouter.delete('/lecturas/:id', async (req, res) => {
  const { id } = req.params;
  await pool.query('DELETE FROM lecturas WHERE id=$1', [id]);
  res.status(204).send();
});

// Conectamos el router de admin a la app
app.use('/api/admin', adminRouter);


// ===================================
// SECCIÓN DE INTELIGENCIA ARTIFICIAL (CORREGIDO)
// ===================================
let iaModel = null;
let iaStats = null; // <--- Para guardar MEAN y STD

// Cargar el modelo UNA SOLA VEZ cuando el servidor inicia
async function loadModel() {
  try {
    // 1. Cargar el JSON del modelo
    const modelPath = join(__dirname, 'rf_model.json'); 
    console.log(`Cargando modelo desde: ${modelPath}`);
    const modelJSON = fs.readFileSync(modelPath, 'utf8');
    
    // 2. Cargar las estadísticas (Mean/Std)
    const statsPath = join(__dirname, 'rf_stats.json');
    console.log(`Cargando stats desde: ${statsPath}`);
    const statsJSON = fs.readFileSync(statsPath, 'utf8'); // <-- "G" eliminado
    iaStats = JSON.parse(statsJSON); // Carga { IA_MEAN, IA_STD } // <-- "section." eliminado

    // 3. Re-crear el modelo desde el JSON
    iaModel = RandomForestRegression.load(JSON.parse(modelJSON));
    
    console.log('✅ Modelo de IA (Random Forest) cargado en el backend');
  } catch (err) {
    console.error('❌ Error cargando modelo o stats en backend:', err);
  } // <-- "A" eliminado
}
loadModel(); // Llama a la función al iniciar

// --------------------
// Iniciar servidor
// --------------------
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});