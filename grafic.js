const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const db = require('./database'); // ajuste o caminho se necessário

// tamanho do gráfico
const width = 900;
const height = 400;

const chartCanvas = new ChartJSNodeCanvas({
  width,
  height,
  backgroundColour: "#2b2d31" // Discord dark
});

/**
 * Gera gráfico diretamente do banco
 * @param {string} userId
 */
async function generateUserGraph(userId) {
  try {
    const { labels, values } = db.getUserGraphData(userId);

    if (!labels.length) {
      throw new Error("No graph data");
    }

    const config = {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          {
            label: "Balance (Last 30 Days)",
            data: values,
            fill: true,
            borderWidth: 2,
            tension: 0.4,
            pointRadius: 3,

            // 🎨 estilo dark Discord
            borderColor: "#5865F2", // blurple
            backgroundColor: "rgba(88, 101, 242, 0.2)"
          }
        ]
      },
      options: {
        responsive: false,
        plugins: {
          legend: {
            labels: {
              color: "#ffffff"
            }
          }
        },
        scales: {
          x: {
            ticks: {
              color: "#b5bac1"
            },
            grid: {
              color: "rgba(255,255,255,0.05)"
            }
          },
          y: {
            ticks: {
              color: "#b5bac1"
            },
            grid: {
              color: "rgba(255,255,255,0.05)"
            }
          }
        }
      }
    };

    return await chartCanvas.renderToBuffer(config);

  } catch (err) {
    console.error('❌ [graph] generateUserGraph error:', err);

    // fallback simples (evita crash do bot)
    const fallbackConfig = {
      type: "line",
      data: {
        labels: ["No Data"],
        datasets: [{
          label: "No Data Available",
          data: [0]
        }]
      }
    };

    return await chartCanvas.renderToBuffer(fallbackConfig);
  }
}


module.exports = {
  generateUserGraph
};
