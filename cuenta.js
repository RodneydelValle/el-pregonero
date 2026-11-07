/* IMP TRAVEL — "Iniciar sesión con Google" y favoritos por persona.
 * Usa Firebase (plan gratis Spark, sin tarjeta): Authentication con Google + Firestore.
 * Cada persona guarda sus favoritos en favoritos/{uid}; las reglas (firestore.rules) impiden ver los de otros.
 * Si config/firebase.js está vacío, no hace nada y los favoritos quedan en el navegador.
 *
 * Reglas de sincronización:
 *  - Al iniciar sesión, los favoritos anónimos del navegador se suman a la cuenta.
 *  - Si el navegador ya tenía la copia de esta misma cuenta (sesión restaurada), manda la nube:
 *    así no reaparece lo que se quitó en otro equipo.
 *  - No se escribe nada en la cuenta hasta haberla leído bien; si la lectura falla, se reintenta.
 *  - Cada cambio se guarda al tiro; Firestore los ordena y sus ecos llegan marcados como pendientes.
 *  - Al cerrar sesión (aquí, en otra pestaña o porque venció) los favoritos de esa cuenta salen del navegador. */
import CONFIG from "./config/firebase.js";

const SDK = "https://www.gstatic.com/firebasejs/10.14.1";
const CLAVE_UID = "pregonero:cuenta";   // de quién son los favoritos guardados en este navegador (vacío = anónimos)
const MAX_EVENTOS = 500, MAX_REST = 300;
const cuenta = window.pregoneroCuenta;   // puente que crea app.js

function uidGuardado() { try { return localStorage.getItem(CLAVE_UID); } catch { return null; } }
function recordarUid(uid) {
  try { if (uid) localStorage.setItem(CLAVE_UID, uid); else localStorage.removeItem(CLAVE_UID); } catch { /* sin almacenamiento */ }
}
const unir = (a, b) => [...new Set([...(a || []), ...(b || [])])];
const mismos = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const limpios = (d) => ({
  eventos: Array.isArray(d?.eventos) ? d.eventos.filter((x) => typeof x === "string") : [],
  restaurantes: Array.isArray(d?.restaurantes) ? d.restaurantes.filter((x) => typeof x === "string") : [],
});

async function iniciar() {
  if (!cuenta) return;
  if (!CONFIG || !CONFIG.apiKey) { cuenta.estado({ disponible: false }); return; }

  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`)]);
  const app = initializeApp(CONFIG);
  const auth = A.getAuth(app);
  auth.languageCode = "es";
  const db = F.getFirestore(app);

  let usuario = null;          // sesión actual en esta pestaña
  let ref = null;              // documento de favoritos; solo existe cuando ya se leyó bien la cuenta
  let uidPestana = null;       // de quién son los favoritos que esta pestaña tiene en memoria
  let cambiosSinSubir = false; // hubo cambios con sesión antes de poder leer la cuenta
  let desuscribir = null, reintento = null, intentos = 0;

  function escribir(fav) {
    // Se guardan los más nuevos si se pasa del tope (el orden de los Set es el de inserción)
    return F.setDoc(ref, {
      eventos: fav.eventos.slice(-MAX_EVENTOS), restaurantes: fav.restaurantes.slice(-MAX_REST),
      actualizado: F.serverTimestamp(),
    }).catch((e) => cuenta.error("No se pudieron guardar tus favoritos en tu cuenta", e));
  }

  cuenta.entrar = async () => {
    const proveedor = new A.GoogleAuthProvider();
    proveedor.setCustomParameters({ prompt: "select_account" });
    try {
      await A.signInWithPopup(auth, proveedor);
    } catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
        await A.signInWithRedirect(auth, proveedor);
      } else if (e.code === "auth/operation-not-allowed") {
        cuenta.error("El inicio de sesión con Google aún no está habilitado (Firebase → Authentication → Método de acceso)", e);
      } else if (e.code === "auth/unauthorized-domain") {
        cuenta.error("Falta autorizar este dominio en Firebase (Authentication → Configuración → Dominios autorizados)", e);
      } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
        cuenta.error("No se pudo iniciar sesión", e);
      }
    }
  };
  cuenta.salir = async () => {
    // Que lleguen a la cuenta los últimos cambios antes de cerrar la sesión (máximo 3 s)
    try { await Promise.race([F.waitForPendingWrites(db), new Promise((ok) => setTimeout(ok, 3000))]); } catch { /* sigue */ }
    await A.signOut(auth);
  };
  cuenta.guardar = (fav) => {
    if (!usuario) return;
    if (!ref) { cambiosSinSubir = true; return; }   // se suben cuando se logre leer la cuenta
    escribir(fav);
  };

  async function sincronizar(u) {
    clearTimeout(reintento);
    const docRef = F.doc(db, "favoritos", u.uid);
    try {
      const snap = await F.getDoc(docRef);
      if (usuario !== u) return;   // la sesión cambió mientras se leía
      const nube = limpios(snap.exists() ? snap.data() : {});
      const fusionar = !uidGuardado() || cambiosSinSubir;
      const local = cuenta.locales();
      const fav = fusionar
        ? { eventos: unir(nube.eventos, local.eventos), restaurantes: unir(nube.restaurantes, local.restaurantes) }
        : nube;
      ref = docRef; uidPestana = u.uid; cambiosSinSubir = false; intentos = 0;
      recordarUid(u.uid);
      if (!snap.exists() || !mismos(fav.eventos, nube.eventos) || !mismos(fav.restaurantes, nube.restaurantes)) escribir(fav);
      cuenta.favoritos(fav);
      // Lo que se guarde en otro dispositivo aparece aquí al tiro (los ecos de lo propio llegan como pendientes)
      desuscribir = F.onSnapshot(docRef, (s) => {
        if (s.exists() && !s.metadata.hasPendingWrites) cuenta.favoritos(limpios(s.data()));
      }, (e) => console.error(e));
    } catch (e) {
      if (usuario !== u) return;
      intentos += 1;
      cuenta.error("No se pudieron leer tus favoritos de tu cuenta; lo vuelvo a intentar", e);
      reintento = setTimeout(() => sincronizar(u), Math.min(60000, 5000 * 2 ** (intentos - 1)));
    }
  }
  window.addEventListener("online", () => { if (usuario && !ref) sincronizar(usuario); });

  A.onAuthStateChanged(auth, (u) => {
    desuscribir?.(); desuscribir = null; ref = null; clearTimeout(reintento); intentos = 0;
    const previo = uidGuardado();
    usuario = u;
    if (!u) {
      if (previo || uidPestana) { recordarUid(null); cuenta.limpiarLocales(); }
      uidPestana = null; cambiosSinSubir = false;
      cuenta.estado({ disponible: true, usuario: null });
      return;
    }
    // Los favoritos de otra cuenta no se mezclan con los de esta
    if ((previo && previo !== u.uid) || (uidPestana && uidPestana !== u.uid)) {
      recordarUid(null); cuenta.limpiarLocales(); cambiosSinSubir = false;
    }
    cuenta.estado({ disponible: true, usuario: { nombre: u.displayName || u.email || "", foto: u.photoURL || null } });
    sincronizar(u);
  });
}

iniciar().catch((e) => {
  console.error(e);
  cuenta?.estado({ disponible: false, error: true });
});
