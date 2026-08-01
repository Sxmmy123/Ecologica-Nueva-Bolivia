// Configuracion e inicializacion base de Firebase.
// Este archivo debe cargarse antes de los demas archivos de sincronizacion.
(function () {
  "use strict";

  // 1) En Firebase abre: Configuracion del proyecto > Tus apps > Web.
  // 2) Copia el objeto firebaseConfig y reemplaza estos datos.
  // 3) Activa Realtime Database en el proyecto.
  window.firebaseConfig = {
      apiKey: "AIzaSyBKV8AhkYLFOAGbvB2zkdc4OtMlfwmxwU0",
      authDomain: "sistema-escolar-1415f.firebaseapp.com",
      databaseURL: "https://sistema-escolar-1415f-default-rtdb.firebaseio.com",
      projectId: "sistema-escolar-1415f",
      storageBucket: "sistema-escolar-1415f.firebasestorage.app",
      messagingSenderId: "96923207142",
      appId: "1:96923207142:web:c03be7478b2d53395f4227"
  };
  
  // Este nombre separa los respaldos si despues tienes otra unidad educativa.
  window.APP_SYNC_ID = "proyecto1";
  
  // Correos autorizados para entrar como administrador desde Firebase Authentication.
  window.ADMIN_AUTH_EMAILS = ["samuel@ecologica.com"];
  

  window.FirebaseSchoolSync = window.FirebaseSchoolSync || {};
  window.FirebaseSchoolSync.version = "v2.26";
  window.FirebaseSchoolSync.databaseRoot = "sistemaEscolar";
})();
