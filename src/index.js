import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import rateLimit from 'express-rate-limit';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Pool } from 'pg';
import admin from 'firebase-admin';
import cron from 'node-cron';

dotenv.config();

const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const pool = new Pool({
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER, 
  password: process.env.PGPASSWORD,
  port: 5432,
  ssl: {
    required: true,
    rejectUnauthorized: false,
  }
});

const app = express();
const port = process.env.PORT || 5001;

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 10000, 
  max: 1000, 
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Demasiadas solicitudes, por favor intente más tarde'
  }
});

app.use(express.json());
app.use(apiLimiter);
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: true,
}));
app.use(passport.initialize());
app.use(passport.session());

async function query(text, params) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result.rows;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  } finally {
    client.release();
  }
}





app.get('/api/materias/progreso', async (req, res) => {
  const client = await pool.connect();
  try {
    const { gestion } = req.query;

    let query = `
      SELECT 
        m.name AS nombre_materia,
        
  
        SUM(m.elementos_totales) AS elementos_totales,
        SUM(m.elem_completados) AS elem_completados,
        SUM(m.elem_evaluados) AS elem_evaluados,
        SUM(m.rec_totales) AS rec_totales,
        SUM(m.rec_tomados) AS rec_tomados,

    
        ROUND(
          (SUM(m.elem_completados)::DECIMAL / NULLIF(SUM(m.elementos_totales), 0)) * 100
        ) AS progreso_general,

      
        ROUND(
          (SUM(m.elem_evaluados)::DECIMAL / NULLIF(SUM(m.elementos_totales), 0)) * 100
        ) AS evaluaciones,

        
        COALESCE(
          ROUND(AVG(
            CASE WHEN ec.saberes_totales > 0 THEN
              (ec.saberes_completados::DECIMAL / ec.saberes_totales) * 100
            ELSE 0 END
          )), 0
        ) AS saberes_minimos

      FROM materia m
      LEFT JOIN elemento_competencia ec ON m.id = ec.materia_id
      WHERE m.vigente = true
    `;

    const params = [];
    if (gestion) {
      query += ` AND m.gestion = $1`;
      params.push(gestion);
    }

    query += `
      GROUP BY m.name
      ORDER BY m.name;
    `;

    const result = await client.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error al obtener progreso de materias:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener progreso de materias',
      error: error.message
    });
  } finally {
    client.release();
  }
});








// Endpoints para mobile

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

async function sendFCMNotification(fcmTokens, payload) {
  try {
    if (!fcmTokens || fcmTokens.length === 0) {
      console.log('No FCM tokens provided');
      return;
    }

    const responses = [];
    for (const tokenRow of fcmTokens) {
      const token = tokenRow.fcm_token;
      console.log('Token:', token);
      console.log('Payload:', payload);
      
      const message = {
        token: token.trim(),
        notification: {
          title: payload.title,
          body: payload.body
        },
        data: {
          type: payload.type || 'general',
          competitionId: payload.competitionId ? payload.competitionId.toString() : ''
        },
        android: {
          notification: {
            channel_id: 'competition_notifications',
            priority: 'high',
            default_sound: true,
            default_vibrate_timings: true,
            default_light_settings: true
          }
        },
        apns: {
          payload: {
            aps: {
              alert: {
                title: payload.title,
                body: payload.body
              },
              sound: 'default',
              badge: 1
            }
          }
        }
      };

      try {
        const response = await admin.messaging().send(message);
        console.log('FCM notification sent successfully:', response);
        responses.push(response);
      } catch (error) {
        console.error('Error sending FCM notification:', error);
        if (error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered') {
          await removeInvalidFcmToken(token);
        }
      }
    }

    return responses;
  } catch (error) {
    console.error('Unexpected error in sendFCMNotification:', error);
  }
}

async function removeInvalidFcmToken(fcmToken) {
  try {
    await query('DELETE FROM usuario_fcm_token WHERE fcm_token = $1', [fcmToken]);
    console.log('Removed invalid FCM token:', fcmToken);
  } catch (error) {
    console.error('Error removing invalid FCM token:', error);
  }
}

async function saveNotificationToHistory(userId, competitionId, type, title, message) {
  try {
    await query(`
      INSERT INTO notificacion (usuario_id, competencia_id, tipo, titulo, mensaje, fecha)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [userId, competitionId, type, title, message]);
    console.log('Notification saved to history');
  } catch (error) {
    console.error('Error saving notification to history:', error);
  }
}

async function checkAndSendNotifications() {
  console.log('Checking for notifications to send...');
  
  try {
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000));
    
    const overdueCompetitions = await query(`
      SELECT ec.*, ec.id as competition_id, m.docente_id as user_id, m.name as materia_nombre
      FROM elemento_competencia ec
      JOIN materia m ON ec.materia_id = m.id
      WHERE ec.fecha_limite < $1 
      AND ec.completado = FALSE
      AND NOT EXISTS (
        SELECT 1 FROM notificacion n 
        WHERE n.usuario_id = m.docente_id 
        AND n.competencia_id = ec.id
        AND n.tipo = 'deadline_passed'
        AND DATE(n.fecha) = CURRENT_DATE
      )
    `, [now]);
    
    
    const upcomingCompetitions = await query(`
      SELECT ec.*, ec.id as competition_id, m.docente_id as user_id, m.name as materia_nombre
      FROM elemento_competencia ec
      JOIN materia m ON ec.materia_id = m.id
      WHERE ec.fecha_limite BETWEEN $1 AND $2
      AND ec.completado = FALSE
      AND NOT EXISTS (
        SELECT 1 FROM notificacion n 
        WHERE n.usuario_id = m.docente_id 
        AND n.competencia_id = ec.id
        AND n.tipo = 'deadline_7days'
        AND DATE(n.fecha) = CURRENT_DATE
      )
    `, [now, sevenDaysFromNow]);
    
    console.log(`Found ${overdueCompetitions.length} overdue competitions`);
    console.log(`Found ${upcomingCompetitions.length} upcoming competitions`);
    
    for (const comp of overdueCompetitions) {
      const tokenResult = await query('SELECT fcm_token FROM usuario_fcm_token WHERE user_id = $1', [comp.user_id]);
      
      const bodyMessage = `Elemento de competencia ${comp.descripcion[0]} ha vencido. Materia: ${comp.materia_nombre}`;
      
      if (tokenResult.length > 0) {
        await sendFCMNotification(tokenResult, {
          title: "Fecha límite vencida",
          body: bodyMessage,
          type: 'deadline_passed',
          competitionId: comp.competition_id
        });
      } else {
        console.log(`No FCM tokens found for user ${comp.user_id}`);
      }
      
      await saveNotificationToHistory(
        comp.user_id, 
        comp.competition_id, 
        'deadline_passed', 
        "Fecha límite vencida", 
        bodyMessage
      );
    }
    
    for (const comp of upcomingCompetitions) {
      const tokenResult = await query('SELECT fcm_token FROM usuario_fcm_token WHERE user_id = $1', [comp.user_id]);
      
      
      const bodyMessage = `Elemento de competencia ${comp.descripcion[0]} vence en 7 días. Materia: ${comp.materia_nombre}`;
      
      if (tokenResult.length > 0) {
        await sendFCMNotification(tokenResult, {
          title: "Recordatorio de fecha límite",
          body: bodyMessage,
          type: 'deadline_7days',
          competitionId: comp.competition_id,
          image: 'https://i.imgur.com/qx7dD2k.png'
        });
      } else {
        console.log(`No FCM tokens found for user ${comp.user_id}`);
      }
      
      await saveNotificationToHistory(
        comp.user_id, 
        comp.competition_id, 
        'deadline_7days',
        "Recordatorio de fecha límite", 
        bodyMessage
      );
    }
    
  } catch (error) {
    console.error('Error in checkAndSendNotifications:', error);
  }
}


passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "http://localhost:3000/auth/google/callback",
    },
    (accessToken, refreshToken, profile, done) => {
      return done(null, profile);
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});



app.get('/validate-email', async (req, res) => {
  const { email } = req.query;
  
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: 'Se requiere un correo electrónico válido'
    });
  }
  
  try {
    const result = await query('SELECT EXISTS(SELECT 1 FROM usuario WHERE correo = $1) AS exists', [email]);
    res.json({
      exists: result[0].exists
    });
  } catch (error) {
    console.error('Error al consultar la base de datos:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

app.get('/notificaciones', async (req, res) => {

  const client = await pool.connect();
  const { email} = req.query;
  try {
    const query = 'SELECT n.* FROM notificacion n JOIN usuario u ON n.usuario_id = u.id WHERE u.correo = $1';
    const result = await client.query(query, [email]);
    res.json({
      data: result.rows
    });
  } catch (error) {
    console.error('Error al conectar con la base de datos:', error);
    res.status(500).json({
      success: false,
      message: 'Error al conectar con la base de datos',
      error: error.message
    });
  } finally {
    client.release(); 
  }
});



app.patch('/notificaciones/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    await query('UPDATE notificacion SET leida = TRUE WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({
      success: false,
      message: 'Error al marcar notificación como leída'
    });
  }
});

app.delete('/notificaciones/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await query('DELETE FROM notificacion WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar notificación'
    });
  }
});

app.post('/fcm-token', async (req, res) => {
  try {
    const { email, fcmToken } = req.body;
    
    if (!email || !fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'email y fcmToken son requeridos'
      });
    }
    
    console.log(`Registrando FCM token para email: ${email}`);
    
    
    const userResult = await query(
      'SELECT id FROM usuario WHERE correo = $1 AND activo = true',
      [email]
    );
    
    if (userResult.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado o inactivo'
      });
    }
    
    const userId = userResult[0].id;
    console.log(`Usuario encontrado con ID: ${userId}`);
    
    
    const existingToken = await query(
      'SELECT id, user_id FROM usuario_fcm_token WHERE fcm_token = $1',
      [fcmToken]
    );
    
    if (existingToken.length > 0) {
      console.log(`Token existente encontrado, asociado al usuario: ${existingToken[0].user_id}`);
      
      
      await query(
        'UPDATE usuario_fcm_token SET user_id = $1, updated_at = NOW() WHERE fcm_token = $2',
        [userId, fcmToken]
      );
      
      console.log(`Token actualizado para usuario: ${userId}`);
    } else {
      
      await query(
        'INSERT INTO usuario_fcm_token (user_id, fcm_token, updated_at) VALUES ($1, $2, NOW())',
        [userId, fcmToken]
      );
      
      console.log(`Nuevo token insertado para usuario: ${userId}`);
    }
    
    
    const verificationResult = await query(
      'SELECT user_id FROM usuario_fcm_token WHERE fcm_token = $1',
      [fcmToken]
    );
    
    console.log(`Verificación: Token asociado al usuario: ${verificationResult[0]?.user_id}`);
    
    res.json({ 
      success: true,
      message: 'Token FCM registrado correctamente',
      userId: userId
    });
  } catch (error) {
    console.error('Error updating FCM token:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar token FCM'
    });
  }
});

app.get('/competitions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const competitions = await query(`
      SELECT ec.*, m.name as materia_name, m.sigla
      FROM elemento_competencia ec
      JOIN materia m ON ec.materia_id = m.id
      WHERE m.docente_id = $1 
      ORDER BY ec.fecha_limite ASC
    `, [userId]);
    
    res.json(competitions);
  } catch (error) {
    console.error('Error fetching competitions:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener elementos de competencia'
    });
  }
});


app.post('/test-notificaciones', async (req, res) => {
  try {
    await checkAndSendNotifications();
    res.json({ 
      success: true, 
      message: 'Verificación de notificaciones completada' 
    });
  } catch (error) {
    console.error('Error testing notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Error al probar notificaciones'
    });
  }
});

app.get('/users', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM usuario');
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error al conectar con la base de datos:', error);
    res.status(500).json({
      success: false,
      message: 'Error al conectar con la base de datos',
      error: error.message
    });
  } finally {
    client.release(); 
  }
});
app.delete('/recuperatorio/:id', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id } = req.params;
    
    if (!id || isNaN(parseInt(id))) {
      return res.status(400).json({
        success: false,
        message: 'ID de recuperatorio inválido'
      });
    }
    

    const checkQuery = 'SELECT id FROM recuperatorio WHERE id = $1';
    const checkResult = await client.query(checkQuery, [parseInt(id)]);
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Recuperatorio no encontrado'
      });
    }
    
    const deleteQuery = 'DELETE FROM recuperatorio WHERE id = $1 RETURNING *';
    const deleteResult = await client.query(deleteQuery, [parseInt(id)]);
    
    res.json({
      success: true,
      message: 'Recuperatorio eliminado exitosamente'
    });
    
  } catch (error) {
    console.error('Error al eliminar recuperatorio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar recuperatorio',
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.post('/recuperatorio', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { completado, elemento_competencia_id, fecha_evaluado } = req.body;
    
    if (elemento_competencia_id === undefined || completado === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Los campos elemento_competencia_id y completado son requeridos'
      });
    }
    
    const query = `
      INSERT INTO recuperatorio (completado, elemento_competencia_id, fecha_evaluado) 
      VALUES ($1, $2, $3) 
      RETURNING *
    `;
    
    const values = [
      completado,
      elemento_competencia_id,
      fecha_evaluado || null 
    ];
    
    const result = await client.query(query, values);
    
    res.status(201).json({
      success: true,
      message: 'Recuperatorio creado exitosamente'
    });
    
  } catch (error) {
    console.error('Error al crear recuperatorio:', error);
    
    if (error.code === '23503') {
      res.status(400).json({
        success: false,
        message: 'El elemento_competencia_id especificado no existe'
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Error al crear recuperatorio',
        error: error.message
      });
    }
  } finally {
    client.release();
  }
});

app.patch('/materia/:id/increment', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { 
      rec_tomados = 0, 
      elem_completados = 0, 
      elem_evaluados = 0,
      rec_totales = 0
    } = req.body;
    
    if (rec_tomados === 0 && elem_completados === 0 && elem_evaluados === 0 && rec_totales===0) {
      return res.status(400).json({
        success: false,
        message: 'Debe proporcionar al menos un incremento diferente de 0'
      });
    }

    const query = `
      UPDATE materia
      SET 
        rec_tomados = COALESCE(rec_tomados, 0) + $1,
        elem_completados = COALESCE(elem_completados, 0) + $2,
        elem_evaluados = COALESCE(elem_evaluados, 0) + $3,
        rec_totales = COALESCE(rec_totales, 0) + $4
      WHERE id = $5 
      RETURNING *
    `;
    
    const result = await client.query(query, [rec_tomados, elem_completados, elem_evaluados, rec_totales, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Materia no encontrada'
      });
    }

    res.json({
      success: true,
      message: 'Materia incrementada correctamente',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Error al incrementar la materia:', error);
    res.status(500).json({
      success: false,
      message: 'Error al incrementar la materia',
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.patch('/materia/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { rec_tomados, elem_completados, elem_evaluados, vigente } = req.body;
    
    if (rec_tomados === undefined && elem_completados === undefined && 
        elem_evaluados === undefined && vigente === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Debe proporcionar al menos un campo para actualizar (rec_tomados, elem_completados, elem_evaluados, vigente)'
      });
    }

    let updateFields = [];
    let values = [];
    let paramIndex = 1;

    if (rec_tomados !== undefined) {
      updateFields.push(`rec_tomados = $${paramIndex}`);
      values.push(rec_tomados);
      paramIndex++;
    }

    if (elem_completados !== undefined) {
      updateFields.push(`elem_completados = $${paramIndex}`);
      values.push(elem_completados);
      paramIndex++;
    }

    if (elem_evaluados !== undefined) {
      updateFields.push(`elem_evaluados = $${paramIndex}`);
      values.push(elem_evaluados);
      paramIndex++;
    }

    if (vigente !== undefined) {
      updateFields.push(`vigente = $${paramIndex}`);
      values.push(vigente);
      paramIndex++;
    }

    values.push(id); 

    const query = `UPDATE materia SET ${updateFields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    
    const result = await client.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Materia no encontrada'
      });
    }

    res.json({
      success: true,
      message: 'Materia actualizada correctamente'
    });

  } catch (error) {
    console.error('Error al actualizar la materia:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar la materia',
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.patch('/elemento/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { evaluado, comentario, fecha_registro, fecha_evaluado, saberes_completados, completado } = req.body;
    
    if (evaluado === undefined && comentario === undefined && fecha_registro === undefined && 
        saberes_completados === undefined && completado === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Debe proporcionar al menos un campo para actualizar (evaluado, comentario, fecha_registro, saberes_completados, completado)'
      });
    }

    let updateFields = [];
    let values = [];
    let paramIndex = 1;

    if (evaluado !== undefined) {
      updateFields.push(`evaluado = $${paramIndex}`);
      values.push(evaluado);
      paramIndex++;
    }

    if (comentario !== undefined) {
      updateFields.push(`comentario = $${paramIndex}`);
      values.push(comentario);
      paramIndex++;
    }

    if (fecha_registro !== undefined) {
      updateFields.push(`fecha_registro = $${paramIndex}`);
      values.push(fecha_registro);
      paramIndex++;
    }
    if (fecha_evaluado !== undefined) {
      updateFields.push(`fecha_evaluado = $${paramIndex}`);
      values.push(fecha_evaluado);
      paramIndex++;
    }

    if (saberes_completados !== undefined) {
      updateFields.push(`saberes_completados = $${paramIndex}`);
      values.push(saberes_completados);
      paramIndex++;
    }

    if (completado !== undefined) {
      updateFields.push(`completado = $${paramIndex}`);
      values.push(completado);
      paramIndex++;
    }

    values.push(id);

    const query = `UPDATE elemento_competencia SET ${updateFields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    
    const result = await client.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Elemento no encontrado'
      });
    }

    res.json({
      success: true,
      message: 'Elemento actualizado correctamente'
    });

  } catch (error) {
    console.error('Error al actualizar el elemento:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar el elemento',
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.patch('/recuperatorio/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { completado, fecha_evaluado } = req.body;
    
    if (completado === undefined && fecha_evaluado === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Debe proporcionar al menos un campo para actualizar (completado, fecha_evaluado)'
      });
    }

    let updateFields = [];
    let values = [];
    let paramIndex = 1;

    if (completado !== undefined) {
      updateFields.push(`completado = $${paramIndex}`);
      values.push(completado);
      paramIndex++;
    }

    if (fecha_evaluado !== undefined) {
      updateFields.push(`fecha_evaluado = $${paramIndex}`);
      values.push(fecha_evaluado);
      paramIndex++;
    }

    values.push(id); 

    const query = `UPDATE recuperatorio SET ${updateFields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    
    const result = await client.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Recuperatorio no encontrado'
      });
    }

    res.json({
      success: true,
      message: 'Recuperatorio actualizado correctamente'
    });

  } catch (error) {
    console.error('Error al actualizar el recuperatorio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar el recuperatorio',
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.patch('/saber/:id/completado', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { completado } = req.body;
    
    const result = await client.query(
      'UPDATE saber_minimo SET completado = $1 WHERE id = $2 RETURNING *',
      [completado, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Saber no encontrado'
      });
    }

    res.json({
      success: true,
      message: 'Estado actualizado correctamente'
    });

  } catch (error) {
    console.error('Error al actualizar el saber:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar el saber',
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.get('/recuperatorios', async (req, res) => {

  const client = await pool.connect();
  const { elemento} = req.query;
  try {
    const query = 'SELECT r.* FROM recuperatorio r JOIN elemento_competencia e ON r.elemento_competencia_id = e.id WHERE e.id = $1';
    const result = await client.query(query, [elemento]);
    res.json({
      data: result.rows
    });
  } catch (error) {
    console.error('Error al conectar con la base de datos:', error);
    res.status(500).json({
      success: false,
      message: 'Error al conectar con la base de datos',
      error: error.message
    });
  } finally {
    client.release(); 
  }
});

app.get('/saberes', async (req, res) => {

  const client = await pool.connect();
  const { elemento} = req.query;
  try {
    const query = 'SELECT s.* FROM saber_minimo s JOIN elemento_competencia e ON s.elemento_competencia_id = e.id WHERE e.id = $1';
    const result = await client.query(query, [elemento]);
    res.json({
      data: result.rows
    });
  } catch (error) {
    console.error('Error al conectar con la base de datos:', error);
    res.status(500).json({
      success: false,
      message: 'Error al conectar con la base de datos',
      error: error.message
    });
  } finally {
    client.release(); 
  }
});

app.get('/users', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM usuario');
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error al conectar con la base de datos:', error);
    res.status(500).json({
      success: false,
      message: 'Error al conectar con la base de datos',
      error: error.message
    });
  } finally {
    client.release(); 
  }
});
app.get('/elementos', async (req, res) => {

  const client = await pool.connect();
  const { materia} = req.query;
  try {
    const query = 'SELECT e.* FROM elemento_competencia e JOIN materia m ON e.materia_id = m.id WHERE m.id = $1 ORDER BY e.descripcion';
    const result = await client.query(query, [materia]);
    res.json({
      data: result.rows
    });
  } catch (error) {
    console.error('Error al conectar con la base de datos:', error);
    res.status(500).json({
      success: false,
      message: 'Error al conectar con la base de datos',
      error: error.message
    });
  } finally {
    client.release(); 
  }
});

app.get('/materia/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const query = 'SELECT * FROM materia WHERE id = $1';
    const result = await client.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Materia no encontrada'
      });
    }

    res.json({
      data: result.rows
    });

  } catch (error) {
    console.error('Error al obtener la materia:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener la materia',
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.get('/materias', async (req, res) => {

  const client = await pool.connect();
  const { email} = req.query;
  try {
    const query = 'SELECT m.* FROM materia m JOIN usuario u ON m.docente_id = u.id WHERE u.correo = $1';
    const result = await client.query(query, [email]);
    res.json({
      data: result.rows
    });
  } catch (error) {
    console.error('Error al conectar con la base de datos:', error);
    res.status(500).json({
      success: false,
      message: 'Error al conectar con la base de datos',
      error: error.message
    });
  } finally {
    client.release(); 
  }
});

app.get('/validate-email', async (req, res) => {
  const { email } = req.query;
  
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: 'Se requiere un correo electrónico válido'
    });
  }

  const client = await pool.connect();
  try {

    const query = 'SELECT EXISTS(SELECT 1 FROM usuario WHERE correo = $1) AS exists';
    const result = await client.query(query, [email]);
    res.json({
      exists: result.rows[0].exists
    });
  } catch (error) {
    console.error('Error al consultar la base de datos:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  } finally {
    client.release();
  }
});
app.post('/create-user', async (req, res) => {
  const { email, password, displayName } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: 'Email y contraseña son requeridos'
    });
  }


  const client = await pool.connect();
  try {
    
    const queryCheck = 'SELECT EXISTS(SELECT 1 FROM usuario WHERE correo = $1) AS exists';
    const resultCheck = await client.query(queryCheck, [email]);
  

    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      displayName: displayName || email.split('@')[0],
      emailVerified: true, 
    });

    res.json({
      success: true,
      message: 'Usuario creado exitosamente',
      uid: userRecord.uid
    });

  } catch (error) {
    console.error('Error al crear usuario:', error);
    
    if (error.code === 'auth/email-already-exists') {
      return res.status(400).json({
        success: false,
        message: 'El usuario ya existe. Use la opción de inicio de sesión.'
      });
    }
    
    if (error.code === 'auth/weak-password') {
      return res.status(400).json({
        success: false,
        message: 'La contraseña debe tener al menos 6 caracteres'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  } finally {
    client.release();
  }
});

app.post('/set-password', async (req, res) => {
  const { email, newPassword } = req.body;

  if (!email || !newPassword) {
    return res.status(400).json({
      success: false,
      message: 'Email y nueva contraseña son requeridos'
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'La contraseña debe tener al menos 6 caracteres'
    });
  }

  const client = await pool.connect();
  try {
    const queryCheck = 'SELECT EXISTS(SELECT 1 FROM usuario WHERE correo = $1) AS exists';
    const resultCheck = await client.query(queryCheck, [email]);
    
    if (!resultCheck.rows[0].exists) {
      return res.status(403).json({
        success: false,
        message: 'Usuario no autorizado'
      });
    }
    
    const userRecord = await admin.auth().getUserByEmail(email);
    
    await admin.auth().updateUser(userRecord.uid, {
      password: newPassword
    });

    res.json({
      success: true,
      message: 'Contraseña establecida exitosamente'
    });

  } catch (error) {
    console.error('Error al establecer contraseña:', error);
    
    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }
    
    if (error.code === 'auth/weak-password') {
      return res.status(400).json({
        success: false,
        message: 'La contraseña debe tener al menos 6 caracteres'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  } finally {
    client.release();
  }
});

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "http://localhost:3000/auth/google/callback",
    },
    (accessToken, refreshToken, profile, done) => {
      return done(null, profile);
    }
  )
);



passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "http://localhost:3000/auth/google/callback",
    },
    (accessToken, refreshToken, profile, done) => {
      return done(null, profile);
    }
  )
);



cron.schedule('0 * * * *', () => {
  console.log('Running scheduled notification check...');
  checkAndSendNotifications();
});


cron.schedule('0 */6 * * *', () => {
  console.log('Running 6-hour notification check...');
  checkAndSendNotifications();
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
  console.log('Notification scheduler initialized');
  

  setTimeout(() => {
    checkAndSendNotifications();
  }, 5000); 
});