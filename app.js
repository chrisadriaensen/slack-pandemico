/* IMPORTS */
const express = require('express');
const fetch = require('node-fetch');
const { createEventAdapter } = require('@slack/events-api');
const { createMessageAdapter } = require('@slack/interactive-messages');
const { WebClient } = require('@slack/web-api');

/* GLOBAL VARIABLES */
const app = express();
const port = process.env.PORT || 8080;
const slackEvents = createEventAdapter(process.env.SLACK_SIGNING_SECRET);
const slackInteractions = createMessageAdapter(process.env.SLACK_SIGNING_SECRET);
const slackClient = new WebClient(process.env.SLACK_TOKEN);
const covidAPI = 'http://corona-api.com/countries/COUNTRY_CODE';
const flagsAPI = 'https://www.countryflags.io/COUNTRY_CODE/flat/64.png';

/* RECEIVE SLACK EVENTS */
app.use('/events', slackEvents.requestListener());

/* REACT TO APP MENTIONS */
slackEvents.on('app_mention', async event => {
    console.log(`Received mention by ${event.user}: ${event.text}`);

    // Get country code from input
    const countryCode = event.text.split(' ')[1];

    // Fetch country data from COVID API
    try {
        const response = await fetch(covidAPI.replace('COUNTRY_CODE', countryCode));
        if (response.ok) {
            const json = await response.json();

            // Calculate active cases
            const active = json.data.latest_data.confirmed - json.data.latest_data.deaths - json.data.latest_data.recovered;

            // Post country data to Slack channel
            postCountryData(event.channel, {
                country: json.data.name,
                country_code: countryCode,
                population: json.data.population,
                updated: new Date(json.data.updated_at),
                deaths: {
                    today: json.data.today.deaths,
                    total: json.data.latest_data.deaths,
                    rate: Math.round((json.data.latest_data.deaths / json.data.population) * 10000) / 100
                },
                confirmed: {
                    today: json.data.today.confirmed,
                    total: json.data.latest_data.confirmed,
                    rate: Math.round((json.data.latest_data.confirmed / json.data.population) * 10000) / 100
                },
                active: {
                    total: active,
                    rate: Math.round((active / json.data.population) * 10000) / 100
                }
            });

        } else {
            console.log(response);
        }
    } catch (error) {
        console.log(error);
    }
});

/* POST COUNTRY DATA TO CHANNEL */
const postCountryData = async (channel, data) => {
    slackClient.chat.postMessage({
        channel: channel,
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `Latest data for ${data.country}:\n` +
                        "```Active:    " + ' '.repeat(7 - data.active.total.toString().length) +
                            data.active.total + " (" + data.active.rate + "%)\n" +
                        "Confirmed: " + ' '.repeat(7 - data.confirmed.total.toString().length) +
                            data.confirmed.total + " (" + data.confirmed.rate + "%) [Today: +" + data.confirmed.today + "]\n" +
                        "Deaths:    " + ' '.repeat(7 - data.deaths.total.toString().length) +
                            data.deaths.total + " (" + data.deaths.rate + "%) [Today: +" + data.deaths.today + "]```"
                },
                accessory: {
                    type: 'image',
                    image_url: flagsAPI.replace('COUNTRY_CODE', data.country_code),
                    alt_text: `flag for ${data.country}`
                }
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: 'Subscribe'
                        },
                        action_id: 'pandemico_subscribe'
                    },
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: 'Lockdown'
                        },
                        style: 'danger',
                        action_id: 'pandemico_lockdown'
                    }
                ]
            },
            {
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `Source: ${covidAPI.replace('COUNTRY_CODE', data.country_code)}\n` +
                              `Updated: ${data.updated}`
                    }
                ]
            }
        ]
    });
};

/* RECEIVE SLACK INTERACTIONS */
app.use('/interactions', slackInteractions.requestListener());

/* REACT TO APP BUTTON INTERACTION */
slackInteractions.action({ type: 'button' }, (payload, respond) => {
    console.log(`Received button interaction: ${payload.type}`);

    if (payload.type === 'block_actions') {
        if (payload.actions.action_id === 'pandemico_subscribe') {

            respond({
                text: 'Thanks for your subscription.',
                response_type: 'ephemeral',
                replace_original: false
            });

        } else if (payload.actions.action_id === 'pandemico_lockdown') {

            respond({
                text: 'Locking down country.',
                response_type: 'ephemeral',
                replace_original: false
            });

        }

        respond({
            text: `Unknown action: ${payload.actions.action_id}`,
            response_type: 'ephemeral',
            replace_original: false
        });
    }

    respond({
        text: `Unknown type: ${payload.type}`,
        response_type: 'ephemeral',
        replace_original: false
    });

});

/* START SERVER */
app.listen(port, () => {
    console.log(`Listening on port ${port}`);
});