import express from "express";
import tf from '@tensorflow/tfjs-node';
import bodyParser from "body-parser";
import cors from "cors";
import pool from "./db.js"; // conexión a PostgreSQL
import mqtt from "mqtt";
import admin from "firebase-admin"; // <-- NUEVO
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
// LÓGICA DE MQTT
// ===================================
const MQTT_BROKER = "762358bc25e4449fb40ac5b6645ff3dc.s1.eu.hivemq.cloud";
const MQTT_PORT = 8883;
const MQTT_USER = "JhonE";
const MQTT_PASSWORD = "192837465Jhon";
const MQTT_TOPIC = "sensores/planta/datos";

const mqttOptions = { 
  host: MQTT_BROKER,
  port: MQTT_PORT,
  protocol: 'mqtts', // 'mqtts' para conexiones seguras TLS (puerto 8883)
  username: MQTT_USER,
  password: MQTT_PASSWORD};
const client = mqtt.connect(mqttOptions);
client.on('connect', () => {
  console.log('✅ Conectado exitosamente al Broker MQTT');
  
  // Suscribirse al topic
  client.subscribe(MQTT_TOPIC, (err) => {
    if (!err) {
      console.log(`👂 Suscrito al topic: ${MQTT_TOPIC}`);
    } else {
      console.error('Error al suscribirse:', err);
    }
  });});
client.on('message', async (topic, payload) => { 
  const messageString = payload.toString();
    console.log(`[MQTT] Mensaje recibido en ${topic}: ${messageString}`);
  
    try {
      // Convertimos el string (que es un JSON) a un objeto
      const datos = JSON.parse(messageString);
  
      const { planta_id, temperatura, humedad, nivel_agua, agua_consumida } = datos;
  
      // --- Esta es la MISMA lógica que tu ruta POST ---
      const query = `
        INSERT INTO lecturas (planta_id, temperatura, humedad, nivel_agua, agua_consumida, fecha)
        VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING *;
      `;
      const values = [planta_id, temperatura, humedad, nivel_agua || null, agua_consumida || null];
      
      // Ejecutamos la consulta
      const result = await pool.query(query, values);
      console.log('[MQTT] Datos guardados en la BD:', result.rows[0]);
  
    } catch (error) {
      console.error("[MQTT] Error al procesar el mensaje o guardar en BD:", error);
    }
});
client.on('error', (err) => { 
  console.error('Error de MQTT:', err);
  });
client.on('reconnect', () => { 
  console.log('Reconectando al Broker MQTT...');
  });

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


// Importar TF-Node y el modelo
let iaModel = null;

// Cargar el modelo UNA SOLA VEZ cuando el servidor inicia
async function loadModel() {
  try {
    // ✅ Correcto: Apuntando al model.json dentro de la carpeta 'modelo_backend'
    //    Asegúrate de que esta carpeta esté subida a Render.
    //    Usamos 'join' y '__dirname' que ya definiste arriba.
    const modelPath = `file://${join(__dirname, 'modelo_backend', 'model.json')}`; 
    console.log(`Cargando modelo desde: ${modelPath}`);

    iaModel = await tf.loadLayersModel(modelPath);
    console.log('✅ Modelo de IA cargado en el backend');
  } catch (err) {
    console.error('❌ Error cargando modelo en backend:', err);
  }
}
loadModel(); // Llama a la función al iniciar

// ... en tu router (Express, etc.) ...
app.post('/api/ia/predecir', async (req, res) => {
  if (!iaModel) {
    return res.status(500).send({ error: 'Modelo no está listo' });
  }

  // 1. Recibir las 9 variables crudas del app.js
  const rawInput = req.body.input; // [temp, hum, sin, cos, ...]

  if (!rawInput || rawInput.length !== 9) {
    return res.status(400).send({ error: 'Se esperaban 9 valores en el array "input"' });
  }

  // 2. Normalizar (¡necesitas las constantes MEAN y STD aquí!)
 const IA_MEAN = [19.217487787857642, 71.75930914166085, 0.0016620385105260921, 0.067683629093006, 15.149685973482205, 25.059316120027912, 69.52023726448012, 79.52023726448012,22.835387299371945];
const IA_STD = [2.4249451811563576, 12.74868811234, 0.6839458433540213, 0.7266234840248392, 0.733345561704264, 0.4185557565303383, 2.2740148501713517, 2.2740148501713517,0.8606089852621961];

  const normalizedInput = rawInput.map((val, i) => (val - IA_MEAN[i]) / IA_STD[i]);

  // 3. Predecir
  const inputTensor = tf.tensor2d([normalizedInput]);
  const prediction = iaModel.predict(inputTensor);
  const humedadFutura = (await prediction.data())[0];

  inputTensor.dispose();
  prediction.dispose();

  // 4. Devolver solo el resultado
  res.json({ prediccion: humedadFutura });
});

// --------------------
// Iniciar servidor
// --------------------
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});