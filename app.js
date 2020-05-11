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
const countries = {};

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
                    text: `Latest status for ${data.country}: ${isCountryClosed(data.country_code) ? 
                        "```CLOSED: Please work from home and refrain from any travel in(to) the country.```" : 
                        "```OPEN:   Please remain cautious, limit office visits and travel in(to) the country.```"}`
                }
            },
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
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `Source: ${covidAPI.replace('COUNTRY_CODE', data.country_code)}\n` +
                            `Updated: ${data.updated}`
                    }
                ]
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
                        action_id: 'pandemico_subscribe',
                        value: data.country_code
                    },
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: isCountryClosed(data.country_code) ? 'Open Country' : 'Close Country'
                        },
                        style: isCountryClosed(data.country_code) ? 'primary' : 'danger',
                        action_id: isCountryClosed(data.country_code) ? 'pandemico_open' : 'pandemico_close',
                        value: data.country_code
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

    // Respond the block actions
    if (payload.type === 'block_actions') {
        for (const action of payload.actions) {

            // Respond the subscribe action
            if (action.action_id === 'pandemico_subscribe') {

                // Subscribe user
                subscribeUser(action.value, action.user);

                respond({
                    text: `User subscribed: ${action.user} to ${action.value}`,
                    response_type: 'ephemeral',
                    replace_original: false
                });

            // Respond the close action
            } else if (action.action_id === 'pandemico_close') {

                // Close country
                setCountryClosed(action.value, true);

                respond({
                    text: `Country closed: ${action.value}`,
                    response_type: 'ephemeral',
                    replace_original: false
                });

            // Respond the open action
            } else if (action.action_id === 'pandemico_open') {

                // Open country
                setCountryClosed(action.value, false);

                respond({
                    text: `Country opened: ${action.value}`,
                    response_type: 'ephemeral',
                    replace_original: false
                });

            // Respond the unknown action
            } else {

                respond({
                    text: `Sorry, I don't recognize this action: ${action}`,
                    response_type: 'ephemeral',
                    replace_original: false
                });

            }

        }

    // Respond the unknown interaction types
    } else {

        respond({
            text: `Sorry, I don't recognize this type of interaction: ${payload.type}`,
            response_type: 'ephemeral',
            replace_original: false
        });

    }

});

/* SUBSCRIBE USER TO COUNTRY */
const subscribeUser = (country, user) => {
    if (countries[country]) {
        if (countries[country].subscribers) {
            countries[country].subscribers.push(user);
        } else {
            countries[country].subscribers = [ user ];
        }
    } else {
        countries[country] = {
          subscribers: [ user ]
        };
    }
};

/* SET COUNTRY CLOSED STATUS */
const setCountryClosed = (country, status) => {
    countries[country] ? countries[country].closed = status : countries[country] = { closed: status };
};

/* GET COUNTRY CLOSED STATUS */
const isCountryClosed = country => countries[country] ? countries[country].closed : false;

/* START SERVER */
app.listen(port, () => {
    console.log(`Listening on port ${port}`);
});