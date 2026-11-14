
import { ProductApiStatus } from "@/components/product-api-status";

const workflowSteps = [
  {
    number: "01",
    title: "Conecta un repositorio público",
    description:
      "Autoriza un proyecto y proporciona una URL canónica de GitHub.",
  },
  {
    number: "02",
    title: "Inventario acotado y seguro",
    description:
      "Se consultan sólo archivos de texto mediante la API pública de GitHub, con límites verificables.",
  },
  {
    number: "03",
    title: "Análisis estático con evidencia",
    description:
      "Cada hallazgo conserva archivo, línea, extracto reducido e identidad de contenido.",
  },
  {
    number: "04",
    title: "Conversación sobre el informe",
    description:
      "Pregunta por hallazgos, ubicaciones, recomendaciones y límites sin inventar conclusiones.",
  },
  {
    number: "05",
    title: "Siguiente comprobación explícita",
    description:
      "El informe separa lo inspeccionado de las pruebas que no se ejecutaron.",
  },
];

const principles = [
  {
    number: "PRINCIPIO 01",
    title: "Hallazgos verificables",
    description:
      "Cada hallazgo incluye la ubicación y el hash del contenido que fue inspeccionado.",
  },
  {
    number: "PRINCIPIO 02",
    title: "Importación con límites",
    description:
      "El MVP limita tamaño, número y tipo de archivo; no sigue URLs arbitrarias ni ejecuta código.",
  },
  {
    number: "PRINCIPIO 03",
    title: "Sin falsas garantías",
    description:
      "Un informe estático no equivale a pruebas ejecutadas, una auditoría completa ni una causa raíz confirmada.",
  },
];

const architecture = [
  {
    type: "Frontend",
    name: "Web application",
    description:
      "Next.js, React y TypeScript para presentar investigaciones y sus evidencias.",
  },
  {
    type: "Producto",
    name: "REST API",
    description:
      "Fastify para administrar las operaciones del producto y validar solicitudes.",
  },
  {
    type: "QA engine",
    name: "Static evidence engine",
    description:
      "Reglas deterministas y trazables sobre una copia acotada de archivos de texto públicos.",
  },
  {
    type: "Investigación avanzada",
    name: "Incident evidence engine",
    description:
      "El flujo previo de incidentes se mantiene separado para preservar procedencia y hechos verificados.",
  },
];

export default function Home() {
  return (
    <>
      <header className="site-header">
        <div className="site-shell header-inner">
          <a
            className="brand"
            href="#inicio"
            aria-label="SentinelOps AI, inicio"
          >
            <span className="brand-mark" aria-hidden="true">
              S
            </span>

            <span className="brand-text">
              SENTINELOPS
              <span>QUALITY ASSISTANT</span>
            </span>
          </a>

          <nav className="nav-links" aria-label="Navegación principal">
            <a href="/qa">QA Workspace</a>
            <a href="/investigation">Investigation avanzada</a>
            <a href="/login">Iniciar sesión</a>
            <a href="#principios">Principios</a>
            <a href="#flujo">Flujo de trabajo</a>
            <a href="#arquitectura">Arquitectura</a>
          </nav>

          <ProductApiStatus />
        </div>
      </header>

      <main id="inicio" className="site-shell">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="status-dot" aria-hidden="true" />
              SOFTWARE QUALITY · EVIDENCE FIRST
            </p>

            <h1 id="hero-title" className="hero-title">
              Entiende la calidad del proyecto.
              <span> Conserva la evidencia.</span>
            </h1>

            <p className="hero-description">
              SentinelOps AI permite importar un repositorio público de GitHub
              en un proyecto autorizado, revisarlo estáticamente y conversar
              sobre hallazgos que conservan ubicación, hash y límites claros.
            </p>

            <div className="hero-actions">
              <a
                className="action-link action-primary"
                href="/qa"
              >
                Abrir QA Workspace
                <span aria-hidden="true">↗</span>
              </a>

              <a className="action-link" href="#arquitectura">
                Ver arquitectura
              </a>
            </div>

            <p className="hero-note">
              MVP de solo lectura: sin ejecutar scripts, instalaciones, pruebas
              ni cambios automáticos en el repositorio.
            </p>
          </div>

          <aside
            className="workflow-card"
              aria-label="Flujo de análisis de QA"
          >
            <div className="card-topline">
              <div>
                <p className="card-caption">QA workflow</p>
                <h2 className="card-title">
                  Del repositorio a la evidencia
                </h2>
              </div>

              <span className="design-label">MVP IMPLEMENTADO</span>
            </div>

            <div className="workflow-list">
              {workflowSteps.map((step) => (
                <div className="workflow-step" key={step.number}>
                  <div className="step-number">{step.number}</div>

                  <div>
                    <h3 className="step-title">{step.title}</h3>
                    <p className="step-description">{step.description}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="card-footnote">
              El análisis estático está implementado. Las cargas ZIP y la
              ejecución aislada de pruebas siguen fuera del alcance del MVP.
            </div>
          </aside>
        </section>

        <section
          id="principios"
          className="section"
          aria-labelledby="principles-title"
        >
          <div className="section-heading">
            <div>
              <p className="section-kicker">Principios del producto</p>

              <h2 id="principles-title" className="section-title">
                Una revisión útil muestra tanto el hallazgo como su límite.
              </h2>
            </div>

            <p className="section-description">
              El objetivo no es puntuar o prometer calidad total. Es producir
              evidencia revisable para orientar la siguiente comprobación.
            </p>
          </div>

          <div className="principle-grid">
            {principles.map((principle) => (
              <article className="principle-card" key={principle.number}>
                <span className="principle-index">{principle.number}</span>
                <h3>{principle.title}</h3>
                <p>{principle.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section
          id="flujo"
          className="section"
          aria-labelledby="workflow-title"
        >
          <div className="section-heading">
            <div>
              <p className="section-kicker">Análisis controlado</p>

              <h2 id="workflow-title" className="section-title">
                Cada etapa deja un límite y una evidencia explícitos.
              </h2>
            </div>

            <p className="section-description">
              Las reglas, el inventario inspeccionado y las exclusiones se
              devuelven junto con el informe para que la revisión sea auditable.
            </p>
          </div>

          <div className="principle-grid">
            {workflowSteps.map((step) => (
              <article className="principle-card" key={step.number}>
                <span className="principle-index">
                  ETAPA {step.number}
                </span>

                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section
          id="arquitectura"
          className="section"
          aria-labelledby="architecture-title"
        >
          <div className="section-heading">
            <div>
              <p className="section-kicker">Arquitectura del MVP</p>

              <h2 id="architecture-title" className="section-title">
                Un asistente de QA sin perder la evidencia.
              </h2>
            </div>

            <p className="section-description">
              El frontend, el proxy autenticado, la API de producto y el motor
              estático mantienen límites definidos y contratos explícitos.
            </p>
          </div>

          <div className="architecture-grid">
            {architecture.map((component) => (
              <article
                className="architecture-card"
                key={component.type}
              >
                <span className="architecture-type">{component.type}</span>
                <h3>{component.name}</h3>
                <p>{component.description}</p>
              </article>
            ))}
          </div>

          <p className="disclaimer">
            Estado: importación GitHub pública y análisis estático implementados
            en el repositorio. No se afirma ejecución de pruebas, análisis ZIP,
            despliegue público ni una auditoría de seguridad completa.
          </p>
        </section>

        <footer className="site-footer">
          <span>SentinelOps AI · Software Quality</span>

          <span className="footer-note">
            Evidencia antes que suposiciones.
          </span>
        </footer>
      </main>
    </>
  );
}
