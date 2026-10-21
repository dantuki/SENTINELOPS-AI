
import { ProductApiStatus } from "@/components/product-api-status";

const workflowSteps = [
  {
    number: "01",
    title: "Triage del incidente",
    description:
      "Identificar síntomas, alcance, servicio afectado y contexto faltante.",
  },
  {
    number: "02",
    title: "Recuperación de evidencia",
    description:
      "Localizar documentación, código y registros dentro del proyecto autorizado.",
  },
  {
    number: "03",
    title: "Investigación mediante MCP",
    description:
      "Consultar herramientas con parámetros validados y permisos limitados.",
  },
  {
    number: "04",
    title: "Verificación de hipótesis",
    description:
      "Contrastar hechos, evidencias contrarias e información insuficiente.",
  },
  {
    number: "05",
    title: "Informe estructurado",
    description:
      "Presentar conclusiones justificadas, incertidumbres y pruebas recomendadas.",
  },
];

const principles = [
  {
    number: "PRINCIPIO 01",
    title: "Evidencias verificables",
    description:
      "Las afirmaciones técnicas deberán enlazarse con fuentes reales y ubicaciones comprobables.",
  },
  {
    number: "PRINCIPIO 02",
    title: "Herramientas con límites",
    description:
      "Las consultas se ejecutarán mediante herramientas autorizadas. La primera versión será de solo lectura.",
  },
  {
    number: "PRINCIPIO 03",
    title: "Incertidumbre explícita",
    description:
      "Una hipótesis no se presentará como causa raíz confirmada cuando las evidencias no sean suficientes.",
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
    type: "Inteligencia",
    name: "AI orchestrator",
    description:
      "Python, FastAPI y LangGraph para coordinar investigaciones con estado explícito.",
  },
  {
    type: "Herramientas",
    name: "MCP server",
    description:
      "Servicio independiente para exponer herramientas de investigación autorizadas.",
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
              <span>AI INCIDENT INTELLIGENCE</span>
            </span>
          </a>

          <nav className="nav-links" aria-label="Navegación principal">
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
              SOFTWARE INCIDENT INTELLIGENCE
            </p>

            <h1 id="hero-title" className="hero-title">
              No adivines la causa raíz.
              <span> Encuentra la evidencia.</span>
            </h1>

            <p className="hero-description">
              SentinelOps AI está diseñado para ayudar a los equipos de
              desarrollo a investigar fallos mediante recuperación documental,
              herramientas autorizadas y resultados que distinguen hechos,
              hipótesis e incertidumbres.
            </p>

            <div className="hero-actions">
              <a className="action-link action-primary" href="#flujo">
                Explorar el flujo
                <span aria-hidden="true">↗</span>
              </a>

              <a className="action-link" href="#arquitectura">
                Ver arquitectura
              </a>
            </div>

            <p className="hero-note">
              Datos de demostración y fuentes autorizadas como alcance inicial.
              Sin cambios automáticos en sistemas de producción.
            </p>
          </div>

          <aside
            className="workflow-card"
            aria-label="Flujo conceptual de investigación"
          >
            <div className="card-topline">
              <div>
                <p className="card-caption">Investigation workflow</p>
                <h2 className="card-title">
                  De un síntoma a la evidencia
                </h2>
              </div>

              <span className="design-label">DISEÑO CONCEPTUAL</span>
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
              Este flujo describe el diseño previsto. No representa una
              investigación ejecutándose en tiempo real.
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
                Un diagnóstico útil también sabe reconocer sus límites.
              </h2>
            </div>

            <p className="section-description">
              El objetivo no es generar una respuesta convincente a toda costa.
              Es producir una investigación trazable que pueda revisarse y
              ponerse a prueba.
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
              <p className="section-kicker">Investigación controlada</p>

              <h2 id="workflow-title" className="section-title">
                Cada etapa debe dejar evidencia de lo que hizo.
              </h2>
            </div>

            <p className="section-description">
              El workflow se implementará con estados explícitos, límites de
              ejecución y condiciones de parada verificables.
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
              <p className="section-kicker">Arquitectura prevista</p>

              <h2 id="architecture-title" className="section-title">
                Servicios separados. Responsabilidades claras.
              </h2>
            </div>

            <p className="section-description">
              El frontend, la API de producto, el motor de IA y el servidor MCP
              mantendrán límites definidos y contratos explícitos.
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
            Estado: interfaz inicial en construcción. Las descripciones
            anteriores explican el diseño del producto; no indican que todos
            los servicios estén integrados o desplegados.
          </p>
        </section>

        <footer className="site-footer">
          <span>SentinelOps AI · Software Incident Intelligence</span>

          <span className="footer-note">
            Evidencia antes que suposiciones.
          </span>
        </footer>
      </main>
    </>
  );
}
