/* Configuración de Firebase para "Iniciar sesión con Google" y guardar favoritos por persona.
 *
 * Proyecto: eventosimp-ec898 (plan gratis Spark). Estos datos son públicos por diseño: van en el
 * código de cualquier página web que use Firebase. Lo que protege los favoritos son las reglas de
 * firestore.rules (cada persona solo puede leer y escribir los suyos).
 * No se usa Google Analytics. Si esto se deja en null, la web funciona igual y los favoritos
 * quedan solo en el navegador.
 */
export default {
  apiKey: "AIzaSyCm1Hs-aCPZQJJ2blaY3FtI8g_W4nNfm10",
  authDomain: "eventosimp-ec898.firebaseapp.com",
  projectId: "eventosimp-ec898",
  storageBucket: "eventosimp-ec898.firebasestorage.app",
  messagingSenderId: "994562839195",
  appId: "1:994562839195:web:a3a9e465043f2b2fb9ec3e",
};
