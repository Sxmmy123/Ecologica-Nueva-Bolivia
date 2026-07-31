// Funciones de impresion y exportacion de asistencia.
// Separadas de dia.html para mantener la pagina estable y facil de mantener.

function nombreArchivoSeguro(texto) {
    return String(texto || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
  }

  function tablaResumenAsistenciaActual() {
    return document.querySelector("#detalleCursos .attendance-table");
  }

  function tituloResumenAsistencia() {
    return `Asistencia - ${cursoVistaActual || "Curso"} - ${etiquetaTrimestre(trimestreActual())}`;
  }

  function imprimirResumenAsistencia() {
    const tabla = tablaResumenAsistenciaActual();
    if (!tabla) return alert("No hay tabla de asistencia para imprimir.");
    const ventana = window.open("", "_blank");
    if (!ventana) return alert("No se pudo abrir la ventana de impresion.");
    ventana.document.write(`
      <!doctype html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <title>${escaparHTML(tituloResumenAsistencia())}</title>
        <style>
          @page { size: letter landscape; margin: 8mm; }
          body { color:#111; font-family:Arial, sans-serif; margin:0; }
          h1 { font-size:16px; margin:0 0 4px; text-align:center; }
          .meta { font-size:11px; font-weight:700; margin-bottom:8px; text-align:center; }
          table { border-collapse:collapse; font-size:9px; width:100%; }
          th, td { border:1px solid #222; padding:3px 4px; text-align:center; vertical-align:middle; }
          th { background:#e9eef5; font-weight:900; }
          .student-col { text-align:left; white-space:nowrap; }
          .estado-verde { background:#d4edda; }
          .estado-amarillo { background:#fff3cd; }
          .estado-morado { background:#e0c3fc; }
          .estado-rojo, .estado-blanco { background:#f8d7da; }
          .total-cell { background:#f8fafc; font-weight:900; }
        </style>
      </head>
      <body>
        <h1>${escaparHTML(tituloResumenAsistencia())}</h1>
        <div class="meta">Generado: ${new Date().toLocaleString("es-BO")}</div>
        ${tabla.outerHTML}
      </body>
      </html>
    `);
    ventana.document.close();
    ventana.focus();
    setTimeout(() => {
      ventana.print();
      ventana.close();
    }, 250);
  }

  function abrirExportarAsistenciaExcel() {
    if (!cursoVistaActual) return alert("Seleccione un curso para exportar asistencia.");
    const existente = document.getElementById("modalExportarAsistencia");
    if (existente) existente.remove();
    const modal = document.createElement("div");
    modal.className = "modal fade";
    modal.id = "modalExportarAsistencia";
    modal.tabIndex = -1;
    const botones = TRIMESTRES.map(tri => {
      const clase = tri === trimestreActual() ? "btn-primary" : "btn-outline-primary";
      return '<button type="button" class="btn ' + clase + ' fw-bold" onclick="exportarResumenAsistenciaExcel(\'' + tri + '\')" data-bs-dismiss="modal">' + etiquetaTrimestre(tri) + '</button>';
    }).join("");
    modal.innerHTML = '<div class="modal-dialog modal-dialog-centered"><div class="modal-content">' +
      '<div class="modal-header"><h5 class="modal-title"><i class="bi bi-file-earmark-spreadsheet-fill"></i> Exportar asistencia</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>' +
      '<div class="modal-body"><div class="fw-bold text-primary mb-2">' + escaparHTML(cursoVistaActual) + '</div>' +
      '<div class="text-muted fw-bold small mb-3">Elige el trimestre que deseas exportar en Excel.</div>' +
      '<div class="d-grid gap-2">' + botones + '</div></div></div></div>';
    document.body.appendChild(modal);
    new bootstrap.Modal(modal).show();
    modal.addEventListener("hidden.bs.modal", () => modal.remove(), { once:true });
  }

  function anchoNombreExcel(alumnos) {
    const mayor = alumnos.reduce((max, nombre) => Math.max(max, String(nombre || "").length), 0);
    return Math.max(150, Math.min(260, Math.ceil(mayor * 6.5) + 22));
  }

  function celdaEstadoExcel(estado) {
    const etiqueta = etiquetaEstado(estado);
    const color = { verde:"#d9ead3", amarillo:"#fff2cc", morado:"#eadcf8", blanco:"#f4cccc", rojo:"#f4cccc" }[estado] || "#f4cccc";
    return '<td class="state-cell" style="background:' + color + ';">' + etiqueta + '</td>';
  }

  function tablaMesAsistenciaExcel(resumen, curso, mesClave) {
    const fechas = resumen.meses[mesClave] || [];
    const anchoNombre = anchoNombreExcel(resumen.alumnos);
    let html = '<h4>' + escaparHTML(etiquetaMes(mesClave + "-01")) + '</h4>' +
      '<table><colgroup><col style="width:28px"><col style="width:' + anchoNombre + 'px">' +
      fechas.map(() => '<col style="width:34px">').join("") +
      '<col style="width:28px"><col style="width:28px"><col style="width:28px"><col style="width:28px"></colgroup>' +
      '<thead><tr><th>Nro.</th><th>Alumno</th>' + fechas.map(fecha => '<th>' + etiquetaFechaCorta(fecha) + '</th>').join("") + '<th>P</th><th>A</th><th>L</th><th>F</th></tr></thead><tbody>';

    resumen.alumnos.forEach((nombre, index) => {
      const totales = { asistencia:0, atrasos:0, permisos:0, faltas:0 };
      let celdas = "";
      fechas.forEach(fecha => {
        const estado = resumen.asistencias[fecha + "|" + curso + "|" + nombre] || "blanco";
        if (estado === "morado") { totales.asistencia++; totales.permisos++; }
        else if (estado === "verde") totales.asistencia++;
        else if (estado === "amarillo") totales.atrasos++;
        else totales.faltas++;
        celdas += celdaEstadoExcel(estado);
      });
      html += '<tr><td class="num-cell">' + (index + 1) + '</td><td class="student-cell">' + escaparHTML(nombre) + '</td>' + celdas +
        '<td class="total-cell">' + totales.asistencia + '</td><td class="total-cell">' + totales.atrasos + '</td><td class="total-cell">' + totales.permisos + '</td><td class="total-cell">' + totales.faltas + '</td></tr>';
    });

    return html + '</tbody></table>';
  }

  function exportarResumenAsistenciaExcel(trimestreSeleccionado = trimestreActual()) {
    const resumen = datosResumenAsistencia(cursoVistaActual, trimestreSeleccionado);
    if (!resumen.alumnos.length) return alert("No hay alumnos registrados en este curso.");
    if (!resumen.fechasRegistradas.length) return alert("No hay asistencias registradas en " + etiquetaTrimestre(trimestreSeleccionado) + " para este curso.");
    const titulo = "Asistencia - " + (cursoVistaActual || "Curso") + " - " + etiquetaTrimestre(trimestreSeleccionado);
    const tablas = resumen.mesesOrdenados.map(mesClave => tablaMesAsistenciaExcel(resumen, cursoVistaActual, mesClave)).join('<br>');
    const html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="UTF-8"><style>' +
      'body{font-family:Arial Narrow,Arial,sans-serif;color:#111;}h2{font-size:16px;margin:0 0 2px;}h3{font-size:13px;margin:0 0 10px;}h4{background:#12355b;color:#fff;font-size:12px;margin:12px 0 0;padding:4px 6px;}table{border-collapse:collapse;table-layout:fixed;margin-bottom:10px;}th,td{border:1px solid #333;font-size:10px;height:18px;line-height:18px;padding:1px 3px;text-align:center;vertical-align:middle;}th{background:#d9eaf7;font-weight:bold;}.student-cell{text-align:left;white-space:nowrap;overflow:hidden;font-weight:normal;}.num-cell,.state-cell,.total-cell{width:28px;padding-left:1px;padding-right:1px;}.total-cell{background:#eef3f8;font-weight:bold;}' +
      '</style></head><body><h2>' + escaparHTML(titulo) + '</h2><h3>Fechas registradas: ' + resumen.totalColumnasFechas + ' | Generado: ' + new Date().toLocaleString("es-BO") + '</h3>' + tablas + '</body></html>';
    const blob = new Blob([html], { type:"application/vnd.ms-excel;charset=utf-8" });
    const enlace = document.createElement("a");
    enlace.href = URL.createObjectURL(blob);
    enlace.download = (nombreArchivoSeguro(titulo) || "asistencia") + ".xls";
    document.body.appendChild(enlace);
    enlace.click();
    URL.revokeObjectURL(enlace.href);
    enlace.remove();
  }
